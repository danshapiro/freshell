# Background Pane Viewport Screenshots Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the manually tested approach for useful, efficient Freshell screenshots of background panes with large transcripts.

### Explicit constraints
- A pane with 30,000 elements is typical and must produce a useful screenshot efficiently.
- Capture the pane's current viewport without switching tabs, stealing focus, changing live scroll positions, or causing the long whole-app freeze.
- Exclude offscreen transcript history before html2canvas clones it; retain viewport layout and scroll offsets in the capture copy.
- Handle large code blocks by capturing visible lines rather than cloning all syntax-highlight elements.
- Keep the feature simple and proportionate to its low importance.
- Use the-usual workflow, work in a dedicated git worktree, and preserve unrelated work.
- Proceed despite the unrelated existing base-test failure, recording that failure separately.
- Do not deploy or restart the production server, or create a PR without explicit approval.

### Accepted tradeoffs and residuals
- A brief capture-related hesitation remains acceptable; the tested approach does not promise imperceptible capture.
- Preserve the existing html2canvas level of visual accuracy, including its differences from native browser pixels.
- Visible-line capture of a large code block may omit syntax colours.
- Wrapped tool output still needs validation.

**Goal:** Capture the current visible content of a background Freshell pane with typical 30,000-element history efficiently, preserving the user's live selection, focus, active tab/pane, and scroll positions.

**Architecture:** Add one synchronous preparation helper that records transcript viewport geometry and returns html2canvas's existing `ignoreElements` and `onclone` hooks. It omits unrelated content at existing tab/pane boundaries and whole offscreen transcript roots before cloning, repairs spacers and scroll offsets only in the copy, and replaces large nonwrapping highlighted code with its visible plain-text lines. Compose the helper with existing clone reveal/iframe preparation and retain renderer cleanup; leave wrapped plain tool text intact and prove its existing wrapping and nested scrolling with real-browser comparisons.

**Tech Stack:** TypeScript, DOM/CSS geometry, existing html2canvas 1.4.1, Vitest, Playwright Chromium, existing Rust screenshot REST route and test harness. No dependencies, settings, protocol, Redux production state, or backend changes.

## Global Constraints

- Always work in a worktree (in \.worktrees\)
- TypeScript tooling and Electron use NodeNext/ESM; relative imports must include `.js` extensions.
- Do not create or open a PR until the user explicitly approves PR creation for that branch/change. Preparing a branch, committing locally, and pushing the branch is fine; stop before `gh pr create` or any equivalent PR creation step unless approval is explicit.
- Never use broad kill patterns (for example `pkill -f vite` or `pkill node`).
- Before stopping any process, verify it belongs to the worktree (`ps -fp <pid>` and confirm cwd/path includes `.worktrees/...`).
- Do not run production deploys, restart production services, or mutate live hosts unless the user explicitly asks for that operation.
- Never reduce test coverage, mark tests as skip, or simplify tests just to get them to pass unless the user explicitly approves.
- Only write or update a test if it runs the behavior it protects and fails when that behavior breaks. Checking that prose, prompts, docs, or config contain, match, or hash to expected text does not qualify; if such a test already exists and blocks a change, delete it instead of updating it.

Work only in `/home/dan/code/freshell/.worktrees/viewport-screenshots`, branch `the-usual/viewport-screenshots`, based on immutable `6b1c961baf8301dc7ebf8d5fdca7105fbfca9cdb`. The user authorized proceeding despite an unrelated existing FreshAgentView base failure; record its command and receipt separately in the parent run record. This exception authorizes neither fixing that component nor claiming the complete baseline is green. The original base run is parent-owned; do not start another base gate.

Follow [AGENTS.md](../../AGENTS.md) for pnpm 10.34.5, coordinated testing, cloud failure policy, worktree test storage, process cleanup, and final push/PR approval. Both configured test backends are already `cloud`. Fast focused Vitest commands with explicit config below are the documented local iteration path; they do not substitute for cloud receipts. Use the prepared dependencies and runtime files. No production access is needed. Do not copy private transcript artifacts into fixtures or tracked text.

This is an internal screenshot implementation change; there is no new end-user feature, setting, or significant UI change needing README or `docs/index.html` edits. There are no migrations or deploy steps. Recovery is reverting the focused feature commits through the usual reviewed branch process, with no stored data to migrate. Existing capture errors remain normal `ScreenshotResult` failures and retain caller-level diagnostics; do not introduce a telemetry system or log transcript contents.

---

## File responsibilities and existing interfaces

1. Create `src/lib/screenshot-viewport.ts`: source-only geometry snapshots, early omitted-root identity set, clone-only transcript spacers, and the large-code adapter. Each capture owns its closure; there is no cache, registry, serializer, or cancellation framework.
2. Modify `src/lib/ui-screenshot.ts:257,314`: align iframe preparation/correlation with the omitted roots, prepare fresh viewport geometry immediately before the main html2canvas call, and compose `onclone` after existing hidden-chain reveal. Preserve iframe fingerprints and the renderer suspension's `finally`.
3. Modify `test/unit/client/ui-screenshot.test.ts`: behavioral cloner and tests through `captureUiScreenshot`, including failure cleanup. Keep all existing iframe/scope tests.
4. Create `test/e2e-browser/specs/pane-viewport-screenshot.spec.ts`: provider-free real transcript fixtures, same-browser full html2canvas references for modest transcripts, genuine 30,000-element stress, giant code, wrapped tool output, and interaction isolation. Keep test helpers in this spec unless repetition demonstrably needs a local extraction.

Do not change `ScreenshotRequest = { scope: 'pane' | 'tab' | 'view'; paneId?: string; tabId?: string }` or `ScreenshotResult = { ok: boolean; mimeType?: 'image/png'; imageBase64?: string; width?: number; height?: number; changedFocus: boolean; restoredFocus: boolean; error?: string }`. `changedFocus` and `restoredFocus` remain false. REST continues using `POST /api/screenshots` and its existing `{ status: 'ok', data: { path, width, height, ... } }` response.

Source contracts: pane shells use `[data-pane-shell="true"][data-pane-id]`, tabs use `[data-tab-content-id]`, transcript scrollers use `[data-context="fresh-agent-transcript"]`, and **all direct element children** are row roots. This includes ordinary articles, live articles without a turn index, tail captions, and rolled-back sections. Preserve sibling minimap/buttons. FreshAgentItemCard's wrapped tool `<pre>` is plain text with `pre-wrap`, word breaking, `max-h-48`, and its own scroll. MarkdownRenderer's Prism code is nonwrapping `pre > code > span...`, often naturally tall rather than internally scrolled.

The drafts below are pre-implementation proposals. Once execution starts, source supersedes these code blocks; repairs are not backported into the plan. The request, goal, constraints, and task intent remain authoritative.

### Task 1: Bound transcript cloning and preserve viewport geometry

**Files:**
- Create: `src/lib/screenshot-viewport.ts`
- Modify: `src/lib/ui-screenshot.ts:257,314`
- Modify/Test: `test/unit/client/ui-screenshot.test.ts`
- Create/Test: `test/e2e-browser/specs/pane-viewport-screenshot.spec.ts`

**Interfaces:**
- Consumes: resolved `HTMLElement` capture target; iframe inclusion is sampled before preparation, and the main geometry snapshot is taken fresh after async iframe preparation and renderer suspension.
- Produces: `export type PreparedScreenshotViewport = { ignoreElements: (element: Element) => boolean; onclone: (doc: Document, clonedTarget: HTMLElement) => void }` and `export function prepareScreenshotViewport(target: HTMLElement): PreparedScreenshotViewport`.
- Task 2 extends this helper internally; its exported shape stays unchanged.

- [ ] **Step 1: Write failing behavioral tests**

In the screenshot unit file, add a second cloner helper rather than changing existing iframe tests to require full-document cloning. It must check `ignoreElements` **before** importing or visiting a child. Save source/clone pairs so unit DOM scroll restoration models html2canvas. This is test code, not a production serializer:

```ts
function mockPrunedRender(failAfterClone = false) {
  const visited: Element[] = []
  let copy: Document
  vi.mocked(html2canvas).mockImplementation(async (target: any, options: any) => {
    if (target.ownerDocument !== document) {
      return { width: 500, height: 300, toDataURL: () => 'data:image/png;base64,FRAME' } as any
    }
    copy = document.implementation.createHTMLDocument('capture')
    const pairs = new Map<Node, Node>()
    const clone = (source: Node): Node => {
      if (source instanceof Element) visited.push(source)
      const dest = copy.importNode(source, false)
      pairs.set(source, dest)
      for (const child of source.childNodes) {
        if (child instanceof Element && options.ignoreElements?.(child)) continue
        dest.appendChild(clone(child))
      }
      return dest
    }
    copy.replaceChild(clone(document.documentElement), copy.documentElement)
    for (const [source, dest] of pairs) {
      if (source instanceof HTMLElement && dest.nodeType === Node.ELEMENT_NODE) {
        ;(dest as HTMLElement).scrollTop = source.scrollTop
        ;(dest as HTMLElement).scrollLeft = source.scrollLeft
      }
    }
    options.onclone(copy, pairs.get(target))
    if (failAfterClone) throw new Error('render failed after clone')
    return { width: 800, height: 500, toDataURL: () => 'data:image/png;base64,VIEW' } as any
  })
  return { visited, get copy() { return copy! } }
}

function rectAt(node: HTMLElement, top: number, height: number, width = 800) {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top }),
  })
  Object.defineProperties(node, {
    clientHeight: { configurable: true, value: height },
    clientWidth: { configurable: true, value: width },
  })
}

describe('captureUiScreenshot transcript viewport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    vi.mocked(suspendTerminalRenderersForScreenshot).mockResolvedValue(async () => {})
  })

  it.each([false, true])('excludes history before visiting its descendants; render failure=%s', async (fail) => {
    document.body.innerHTML = `
      <textarea id="focus">keep selection</textarea>
      <div data-pane-shell="true" data-pane-id="target">
        <div data-context="fresh-agent-transcript">
          <article id="old"><span id="old-token">old</span></article>
          <article id="visible">current viewport</article>
          <div id="tail">live tail without a turn index</div>
          <section id="future"><span id="future-token">later</span></section>
        </div>
      </div>
      <div data-pane-shell="true" data-pane-id="other">
        <div data-context="fresh-agent-transcript"><article id="unrelated"><span>large unrelated history</span></article></div>
        <section id="editor"><span id="editor-token">unrelated non-transcript content</span></section>
      </div>`
    const target = document.querySelector<HTMLElement>('[data-pane-id="target"]')!
    const scroller = target.querySelector<HTMLElement>('[data-context]')!
    rectAt(target, 0, 500)
    rectAt(scroller, 0, 500)
    const rows = Array.from(scroller.children) as HTMLElement[]
    rows.forEach((row, i) => rectAt(row, [-2000, -20, 450, 2000][i], [300, 400, 100, 300][i]))
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4500 })
    scroller.scrollTop = 2020
    scroller.scrollLeft = 7
    const input = document.querySelector<HTMLTextAreaElement>('#focus')!
    input.focus()
    input.setSelectionRange(2, 6)
    const before = document.body.innerHTML
    const resume = vi.fn(async () => {})
    vi.mocked(suspendTerminalRenderersForScreenshot).mockResolvedValue(resume)
    const render = mockPrunedRender(fail)
    const result = await captureUiScreenshot({ scope: 'pane', paneId: 'target' })
    expect(result.ok).toBe(!fail)
    expect(render.visited.map((node) => node.id)).toContain('visible')
    expect(render.visited.map((node) => node.id)).toContain('tail')
    for (const id of ['old', 'old-token', 'future', 'future-token', 'unrelated', 'editor', 'editor-token']) {
      expect(render.visited.map((node) => node.id)).not.toContain(id)
      expect(render.copy.getElementById(id)).toBeNull()
    }
    expect(render.copy.querySelector('[data-pane-id="other"]')).not.toBeNull()
    expect(render.copy.querySelector('[data-context]')!.scrollTop).toBe(2020)
    expect(document.body.innerHTML).toBe(before)
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
    expect([scroller.scrollTop, scroller.scrollLeft]).toEqual([2020, 7])
    expect(resume).toHaveBeenCalledTimes(1)
  })
})
```

The behavioral cloner deliberately handles `createHTMLDocument`'s null `defaultView` in jsdom. Its geometry unit assertions cannot prove layout; browser tests below own exact coordinates, extent, and pixels.

Also add direct behavioral cases through this cloner for an empty transcript, no transcript, a partially visible first/last row, and a row collection containing live/caption/section roots. A visible row must survive and an offscreen root's descendants must never be visited. Extend the existing clone-target-drift regression with a changed scroller count/pane owner: capture returns an actionable failure and resumes renderers; it must never retry by cloning full history.

Add this regression through the same pre-descent cloner (inside the describe block above), preserving all existing iframe tree/src/pane drift tests:

```ts
it('view capture replaces its visible iframe while omitting a hidden-tab iframe', async () => {
  document.body.innerHTML = `
    <div data-context="global">
      <div data-tab-content-id="visible"><div data-pane-shell="true" data-pane-id="visible-browser">
        <iframe id="visible-frame" src="about:blank"></iframe>
      </div></div>
      <div data-tab-content-id="hidden" style="visibility:hidden"><div data-pane-shell="true" data-pane-id="hidden-browser">
        <iframe id="hidden-frame" src="about:blank"></iframe>
      </div></div>
    </div>`
  const target = document.querySelector<HTMLElement>('[data-context="global"]')!
  const visible = document.querySelector<HTMLIFrameElement>('#visible-frame')!
  const hidden = document.querySelector<HTMLIFrameElement>('#hidden-frame')!
  rectAt(target, 0, 500); rectAt(visible, 0, 300); rectAt(hidden, 0, 300)
  visible.contentDocument!.body.innerHTML = '<h1>Visible iframe canary</h1>'
  const hiddenDocument = vi.fn(() => null)
  Object.defineProperty(hidden, 'contentDocument', { configurable: true, get: hiddenDocument })
  const render = mockPrunedRender()
  const result = await captureUiScreenshot({ scope: 'view' })
  expect(result.ok).toBe(true)
  expect(render.copy.querySelector('[data-pane-id="visible-browser"] [data-screenshot-iframe-image="true"]')).not.toBeNull()
  expect(render.copy.querySelector('#visible-frame')).toBeNull()
  expect(render.copy.querySelector('#hidden-frame')).toBeNull()
  expect(hiddenDocument).not.toHaveBeenCalled()
  expect(render.visited).not.toContain(hidden)
})
```

Also exercise the preparatory await: let the mocked renderer suspension change the transcript's scroll/row geometry before it resolves; assert the main clone retains the newly visible row, omits the formerly visible row, and restores the new literal offset. Run existing count, src and same-src/different-pane iframe drift cases unchanged; a genuinely changed retained iframe list still applies no replacements. The background-pane iframe test must still pre-render/reveal its laid-out hidden iframe.

Create the browser spec and its reusable fixture helpers now. Use these exact fixture interfaces and implementation (the fixtures mount actual FreshAgentTranscript/MarkdownRenderer/Tool components; only provider responses are synthetic):

```ts
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

async function mountTranscript(page: Page, content: FreshAgentTurn[], style: 'serif' | 'mono' = 'serif') {
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

async function reference(page: Page, paneId: string, scope: 'pane' | 'tab' | 'view' = 'pane') {
  await page.addScriptTag({ path: require.resolve('html2canvas/dist/html2canvas.min.js') })
  return page.evaluate(async ({ id, scope }) => {
    const selector = scope === 'pane' ? `[data-pane-shell="true"][data-pane-id="${id}"]`
      : scope === 'tab' ? `[data-tab-content-id="${id}"]` : '[data-context="global"]'
    const target = document.querySelector<HTMLElement>(selector)!
    const canvas = await (window as any).html2canvas(target, {
      backgroundColor: null, allowTaint: true, useCORS: true, logging: false,
      scale: Math.max(1, devicePixelRatio || 1),
      onclone: (_doc: Document, copy: HTMLElement) => {
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
  await page.addScriptTag({ path: require.resolve('html2canvas/dist/html2canvas.min.js') })
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
      onclone: (_doc: Document, copy: HTMLElement) => {
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
      crop, crops: [crop], rows: measured.map(({ row, box }) => ({ text: row.textContent, top: box.top - s.top, height: box.height })) }
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
```

`FreshAgentTurn` is the exported inferred schema type in `shared/fresh-agent-contract.ts`; the fixture includes its required identity, summary and items fields. Alternating roles deliberately avoid adjacent-role article glomming. Mounting a background tab leaves foreground focus intact; no provider process is started. Use a ready foreground fresh-agent composer, or insert a **test-owned** foreground textarea, to retain a visible editable target without terminal cursor blink in comparisons.

Add these complete fidelity tests, using actual coordinates/scroll extent and whole scroller pixels rather than checking that a PNG is merely nonblank:

```ts
for (const style of ['serif', 'mono'] as const) {
  test(`ordinary viewport matches html2canvas at top middle bottom (${style})`, async ({ freshellPage: _p, page, serverInfo, terminal }, testInfo) => {
    await terminal.waitForTerminal()
    const fixture = await mountTranscript(page, turns(18), style)
    for (const fraction of [0, 0.47, 1]) {
      await fixture.scroller.evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction }, fraction)
      await settle(page)
      const offsets = await fixture.scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }))
      const expected = await reference(page, fixture.paneId)
      const shot = await png(page, serverInfo, 'pane', fixture.paneId)
      expect(await compare(page, shot.base64, expected)).toEqual({ different: 0, width: expected.width, height: expected.height })
      expect(await fixture.scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }))).toEqual(offsets)
      await testInfo.attach(`${style}-${fraction}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
      await testInfo.attach(`${style}-${fraction}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
    }
  })
}
```

Add a 30,000-element stress/isolation test in this task, with the following concrete sequence and assertions. Keep its test name `30k background transcript excludes unrelated history and preserves live interaction` and `test.setTimeout(120_000)`; it must run on the configured cloud backend.

1. Mount the actual `turns(600)` target and assert `target.querySelectorAll('*').length >= 30_000`; increase generated rows deterministically if the actual count is lower, never reduce that assertion. At middle and bottom positions, build `viewportReference` from this same source's live row boxes and text. It retains only intersecting rows and positions those copies absolutely at their measured coordinates, with source-computed row styles preserving `:first-child` differences. This independently checks the production spacers, extent and literal scroll restoration. The full scroller crop includes the **same actual minimap** and buttons; there is no cross-fixture cumulative-offset or tick-count assumption and no unbounded reference clone. Keep the ordinary tests' unmodified full html2canvas references unchanged.
2. Mount a separate background tab using a second `turns(600)` fixture and assert its independent count is also at least 30,000. It remains unrelated to the requested pane and provides the whole-document cloning regression.
3. Before capture, focus the original foreground textarea, set selection `[2,6]`, and save its object identity on a test-owned window value. Snapshot Redux `tabs.activeTabId`, all `panes.activePane` entries, selection start/end/direction, `window.scrollX/Y`, and every fixture transcript's `scrollTop/Left`. Add document `focusin`, capture-phase `scroll`, and a store subscription (if no subscribe is exposed, sample via a short interval) to record transient focus/selection/tab/pane/scroll changes. Start an rAF heartbeat storing largest frame gap; these observations begin **after** fixture setup and scrolling have settled.
4. Start `png(...)` without awaiting; send one keyboard character to the foreground textbox while it is in flight; await the shot. The character must land in the original textarea; selection's expected change is solely that keyboard operation. There must be no focus events away from that exact element, no tab/pane changes, and no observed source scroll changes. Compare against a control keyboard operation's selection result, or snapshot the selection before starting capture and perform the character after measuring capture neutrality; do not assert an unchanged selection while intentionally replacing it with a character.
5. Assert PNG dimensions equal the same-source measured reference and `compare(...).different === 0` for its whole scroller crop. Also assert independently measured visible text includes the selected middle/bottom sentinel and the middle first row is partially clipped. Record capture milliseconds, maximum heartbeat gap, element counts, viewport/DPR, source offsets, named test/backend, and actual/reference PNGs through `testInfo.attach`. Assert capture completes within **10 seconds** after fixture readiness: the existing Rust route's 10-second deadline already returns HTTP 503 when the client cannot finish. The elapsed assertion includes response/file overhead and deliberately requires margin inside that real deadline. Heartbeat/keyboard latency remains diagnostic and does not promise imperceptibility. Do not loosen useful content, geometry or timing assertions to hide a failure.
6. Stop only this test's observers/subscription/heartbeat in `finally`. Let the shared fixture own server and page cleanup. All persistent PNGs/logs remain under the suite's configured artifact path; do not copy dependencies or private data.

Implement the stress sequence with this test body; the detailed observations above explain each assertion. The unchanged selection is checked during capture; the separate keyboard proof uses a second capture so its intentional selection edit does not invalidate that check.

```ts
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
      const tick = () => { if (stopped) return; const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; check(); raf = requestAnimationFrame(tick) }
      raf = requestAnimationFrame(tick)
      w.__viewportCaptureObservation = { stop: () => {
        stopped = true; cancelAnimationFrame(raf); check()
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
    expect(observations.errors).toEqual([])
    expect(elapsed).toBeLessThan(10000)
    expect(await compare(page, shot.base64, expected)).toEqual({ different: 0, width: expected.width, height: expected.height })
    await testInfo.attach(`30k-${position}-metrics`, { body: JSON.stringify({ elapsed, ...observations,
      targetElements: await large.pane.locator('*').count(), unrelatedElements: await unrelated.pane.locator('*').count() }), contentType: 'application/json' })
    await testInfo.attach(`30k-${position}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
    await testInfo.attach(`30k-${position}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
  }
  const duringCapture = png(page, serverInfo, 'pane', large.paneId)
  await page.keyboard.insertText('Z')
  await duringCapture
  await expect(page.locator('#viewport-foreground-input')).toHaveValue('keZelection')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('viewport-foreground-input')
})
```

The stress oracle uses the live large source, not the production helper or its output: its measured absolute-row layout is independent of production's spacer arithmetic. It never clones offscreen history or the unrelated huge pane. If fixture construction count needs adjustment, use an even number of rows and update the final-turn sentinel accordingly; source/oracle rendering costs are excluded from production capture timing. Add viewport/DPR and literal inner-pre scroll offsets to the attached metric object when those fixtures introduce an inner scroller.

For tab and view scope coverage add the following complete test. The same modest reference image includes both split panes, and each viewport crop is independently checked:

```ts
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
```

Before starting a scope capture, wait for two animation frames after fixture changes. For background pane/tab keep the hidden ancestor chain and assert no source visibility style changes. Extend the ordinary test's synthetic input with consecutive assistant turns to cover continuation negative margins and `:first-child` styling, plus caption/live/rolled-back roots using the actual supported snapshot fields where available; the unit cloner covers these as arbitrary direct roots regardless of provider projection.

- [ ] **Step 2: Run tests and verify intended failures**

Run:

```bash
pnpm run test:vitest run test/unit/client/ui-screenshot.test.ts test/unit/client/lib/screenshot-capture-env.test.ts --config config/vitest/vitest.config.ts
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/pane-viewport-screenshot.spec.ts
```

Expected: the new cloner test fails because offscreen/unrelated roots are visited; the real stress case on existing code can miss the Rust route's 10-second deadline, so `png()` receives HTTP 503 and fails its expected-200 assertion (rather than reaching a hypothetical 15-second client bound). Ordinary reference cases may already pass and establish the accuracy to preserve. Confirm failures are the missing behavior, with fixtures rendered and REST reached, rather than setup/type failures. Keep the red receipt; do not run giant unoptimized references.

- [ ] **Step 3: Add the minimal production implementation**

Create this initial helper. Correlate source and clone scrollers by DOM order **and** owning pane id; no live attributes are stamped. html2canvas snapshots the complete source document synchronously before its first await, so preparing immediately before invocation prevents an async gap. An unexpected correlation change fails capture clearly instead of falling back to the unbounded clone path.

```ts
const TRANSCRIPT = '[data-context="fresh-agent-transcript"]'
const OVERSCAN = 100

export type PreparedScreenshotViewport = {
  ignoreElements: (element: Element) => boolean
  onclone: (doc: Document, clonedTarget: HTMLElement) => void
}

type Box = { top: number; bottom: number; left: number; right: number }
type TranscriptPlan = {
  paneId: string | null
  rows: HTMLElement[]
  first: number
  end: number
  top: number
  left: number
  height: number
  anchorTop: number
}

function intersection(a: Box, b: Box): Box {
  return { top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom),
    left: Math.max(a.left, b.left), right: Math.min(a.right, b.right) }
}

function viewport(node: HTMLElement): Box {
  const r = node.getBoundingClientRect()
  const top = r.top + node.clientTop, left = r.left + node.clientLeft
  return { top, left, bottom: top + node.clientHeight, right: left + node.clientWidth }
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
  node.style.cssText = 'height:0;min-height:0;flex:0 0 auto;margin:0;padding:0;border:0;pointer-events:none'
  return node
}

export function prepareScreenshotViewport(target: HTMLElement): PreparedScreenshotViewport {
  const doc = target.ownerDocument
  const view = doc.defaultView!
  const targetBox = target.getBoundingClientRect()
  const targetHidden = ['hidden', 'collapse'].includes(view.getComputedStyle(target).visibility)
  const omitted = new Set<Element>()
  // html2canvas clones the whole document, including unrelated terminals and
  // editors. Keep Freshell's known outer layout boxes, omit their contents.
  for (const boundary of doc.querySelectorAll<HTMLElement>('[data-tab-content-id], [data-pane-shell="true"]')) {
    const relevant = target.contains(boundary) || boundary.contains(target)
    const hidden = !targetHidden && ['hidden', 'collapse'].includes(view.getComputedStyle(boundary).visibility)
    if (!relevant || hidden) for (const child of boundary.children) omitted.add(child)
  }
  const sources = Array.from(doc.querySelectorAll<HTMLElement>(TRANSCRIPT)).filter((source) => {
    for (let node: Element | null = source; node; node = node.parentElement) if (omitted.has(node)) return false
    return true
  })
  const plans: TranscriptPlan[] = sources.map((source) => {
    const rows = Array.from(source.children) as HTMLElement[]
    const clip = intersection(targetBox, viewport(source))
    const painted = targetHidden || !['hidden', 'collapse'].includes(view.getComputedStyle(source).visibility)
    const included = target.contains(source) && painted && clip.bottom > clip.top && clip.right > clip.left
    const first = included ? lowerBound(rows, (row) => row.getBoundingClientRect().bottom >= clip.top - OVERSCAN) : 0
    const end = included ? lowerBound(rows, (row) => row.getBoundingClientRect().top > clip.bottom + OVERSCAN) : 0
    rows.forEach((row, index) => { if (index < first || index >= end) omitted.add(row) })
    return { paneId: paneId(source), rows, first, end, top: source.scrollTop, left: source.scrollLeft,
      height: source.scrollHeight,
      anchorTop: first < end ? rows[first].getBoundingClientRect().top - source.getBoundingClientRect().top + source.scrollTop : 0 }
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
        copy.scrollTop = 0
        copy.scrollLeft = 0
        const firstRow = copy.firstElementChild as HTMLElement
        // Never add a top spacer when the original first row remains: it
        // changes :first-child margins, borders, and padding in serif/mono.
        if (plan.first > 0) {
          const top = spacer(copyDoc)
          copy.insertBefore(top, firstRow)
          const current = firstRow.getBoundingClientRect().top - copy.getBoundingClientRect().top
          top.style.height = `${Math.max(0, plan.anchorTop - current)}px`
        }
        if (plan.end < plan.rows.length) {
          const bottom = spacer(copyDoc)
          copy.appendChild(bottom)
          bottom.style.height = `${Math.max(0, plan.height - copy.scrollHeight)}px`
        }
        copy.scrollTop = plan.top
        copy.scrollLeft = plan.left
      })
    },
  }
}
```

Source direct row boxes are chronological; binary searches give logarithmic geometry reads while building the omitted identity set remains linear in rows. Known unrelated tab/pane boundaries omit their direct content children before cloning, so a huge unrelated editor/terminal subtree cannot dominate capture; outer tabs and pane shells have the existing explicit full-size layout and stay present. Transcript plans beneath an omitted boundary are excluded from source/clone correlation. Do not call `querySelectorAll('*')` or compute styles for all descendants in production. Negative continuation margins are why positions come from real boxes rather than accumulated guessed row heights. If browser coverage exposes a row-order assumption violated by actual transcript CSS, adjust this focused range selection using the measured boxes, keeping the pre-clone exclusion guarantee.

In `ui-screenshot.ts`, add `import { prepareScreenshotViewport } from '@/lib/screenshot-viewport'`. Keep the helper's exported shape unchanged. Extend only the private `PreparedIframeCapture.onclone` signature to receive `(doc: Document, clonedTarget: HTMLElement, ignoreElements: (element: Element) => boolean): void`. Replace `prepareIframeCapture` with this small composition of the existing capture/replacement functions:

```ts
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
  return {
    onclone: (doc, clonedTarget, currentOmissions) => {
      const indexes = iframes.map((_, i) => i).filter((i) => retained(iframes[i], currentOmissions))
      const copies = Array.from(clonedTarget.querySelectorAll('iframe'))
      if (copies.length !== indexes.length) return
      for (let i = 0; i < copies.length; i++) {
        if (iframeFingerprint(copies[i]) !== originalFingerprints[indexes[i]]) return
      }
      for (let i = 0; i < copies.length; i++) {
        const replacement = replacements[indexes[i]]
        if (replacement) copies[i].replaceWith(buildIframeReplacementElement(doc, copies[i], replacement))
      }
    },
  }
}
```

Before iframe preparation, take `const iframeViewport = prepareScreenshotViewport(target)` and call `await prepareIframeCapture(target, scale, iframeViewport.ignoreElements)`. That first snapshot only filters iframe pre-renders; discard it for the main render. After both iframe preparation and renderer suspension await, inside the existing `try`, immediately before the main html2canvas call, take **fresh** `const preparedViewport = prepareScreenshotViewport(target)`. Add `ignoreElements: preparedViewport.ignoreElements` to the main options. No await may separate this fresh geometry snapshot from html2canvas's synchronous clone. The composed callback becomes:

```ts
onclone: (doc, clonedTarget) => {
  if (needsReveal) revealClonedTargetChain(clonedTarget)
  preparedViewport.onclone(doc, clonedTarget)
  preparedIframes.onclone(doc, clonedTarget, preparedViewport.ignoreElements)
},
```

Keep the nested iframe html2canvas calls unchanged and retain `finally { await restoreRenderers() }` and the outer result error handling. Omission filtering walks source ancestors, matching early exclusion of entire roots, including hidden-tab and offscreen-row descendants. Count and per-index original pane/src fingerprints still guard every retained replacement; newly included, added, moved or changed frames cannot receive an unrelated image. No live style, focus, tab-selection, or scroll writes are introduced. Existing normal nested scroll restoration remains html2canvas's responsibility; its clone stores/restores source element scroll offsets. Task 2 explicitly restores adapted `<pre>` geometry where content exclusion would otherwise clamp those offsets. Leave html2canvas's exceptional internal clone-iframe cleanup unchanged; that optional lifecycle work is outside this small feature.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm run test:vitest run test/unit/client/ui-screenshot.test.ts test/unit/client/lib/screenshot-capture-env.test.ts --config config/vitest/vitest.config.ts
pnpm run typecheck:client
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/pane-viewport-screenshot.spec.ts
```

Expected: PASS for the new and existing screenshot units, client typecheck, and every new Task 1 browser case. Ordinary crops match full html2canvas exactly at top/middle/bottom; 30k stress exactly matches its independently measured same-source viewport (including its minimap), meets the real 10-second deadline, and has no capture-induced focus/selection/tab/pane/scroll events. The visible-plus-hidden-iframe view regression passes, all original iframe drift safeguards pass, and fresh viewport geometry is used after preparatory awaits. Renderer cleanup remains covered.

- [ ] **Step 5: Refactor while green**

Remove duplicate rectangle/scroller lookup calculations inside preparation and simplify any unnecessary stored fields. Keep one helper module and one per-capture omitted set. Inspect top/middle/bottom screenshots for spacer edges and first-child changes. Retain a contiguous selected row range; do not add a generic DOM abstraction. Run the focused unit and browser commands again after actual refactoring.

- [ ] **Step 6: Run impacted-test verification**

This changes screenshot preparation only, not shared state/config/build interfaces. The impacted set is the screenshot unit file, renderer suspension unit file, new viewport browser spec, existing REST scope/focus regression, and existing iframe screenshot spec:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --config=default test/unit/client/ui-screenshot.test.ts test/unit/client/lib/screenshot-capture-env.test.ts
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/pane-viewport-screenshot.spec.ts test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts test/e2e-browser/specs/browser-pane-screenshot.spec.ts
pnpm run typecheck:client
```

Expected: PASS with named tests actually executed on cloud Chromium, no skipped/zero-test viewport filter, and no unexplained recovered retries. Existing focus-neutrality and iframe test filenames are cloud-legal. Preserve relevant PNGs, counts, timings and failure traces in configured `test-results` artifacts; this is branch evidence, not the unrelated baseline exception.

- [ ] **Step 7: Commit this deliverable**

```bash
git add src/lib/screenshot-viewport.ts src/lib/ui-screenshot.ts test/unit/client/ui-screenshot.test.ts test/e2e-browser/specs/pane-viewport-screenshot.spec.ts
git commit -m "fix: bound transcript screenshot cloning to the viewport"
```

### Task 2: Bound large highlighted code and validate wrapped tool output

**Files:**
- Modify: `src/lib/screenshot-viewport.ts`
- Modify/Test: `test/unit/client/ui-screenshot.test.ts`
- Modify/Test: `test/e2e-browser/specs/pane-viewport-screenshot.spec.ts`

**Interfaces:**
- Consumes: Task 1's `prepareScreenshotViewport(target: HTMLElement): PreparedScreenshotViewport`, direct retained row roots, `intersection`, `viewport`, and per-capture omitted-root set.
- Produces: the same exported helper shape, additionally avoiding highlighted descendant traversal and preserving visible code lines/outer geometry; plain `pre-wrap` tool bodies retain their text and literal clone scroll offsets.

- [ ] **Step 1: Write failing behavioral tests**

Append this test to the Task 1 unit `describe` so its cleanup applies. It tests code in a naturally tall block viewed through a scrolled transcript: `pre.scrollTop === 0` must **not** mean the top source line is captured.

```ts
it('captures middle code lines without visiting 30k highlighted spans', async () => {
  document.body.innerHTML = '<div data-pane-shell="true" data-pane-id="code"><div data-context="fresh-agent-transcript"><article><pre style="white-space:pre;line-height:20px"><code style="font:14px monospace;line-height:20px"></code></pre></article></div></div>'
  const target = document.querySelector<HTMLElement>('[data-pane-id="code"]')!
  const scroller = target.querySelector<HTMLElement>('[data-context]')!
  const row = scroller.firstElementChild as HTMLElement
  const pre = row.querySelector('pre')!
  const code = pre.querySelector('code')!
  const spans: HTMLElement[] = []
  for (let i = 0; i < 30000; i++) {
    const span = document.createElement('span')
    span.textContent = `line_${String(i).padStart(5, '0')}\n`
    spans.push(span)
    code.appendChild(span)
  }
  rectAt(target, 0, 500); rectAt(scroller, 0, 500)
  rectAt(row, -200000, 600000); rectAt(pre, -200000, 600000)
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 500 }, clientWidth: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 600000 },
  })
  scroller.scrollTop = 200000
  pre.scrollLeft = 37
  const render = mockPrunedRender()
  expect((await captureUiScreenshot({ scope: 'pane', paneId: 'code' })).ok).toBe(true)
  expect(render.visited).not.toContain(code)
  expect(spans.some((span) => render.visited.includes(span))).toBe(false)
  const copiedPre = render.copy.querySelector('pre')!
  expect(copiedPre.textContent).toContain('line_10000')
  expect(copiedPre.textContent).not.toContain('line_00000')
  expect(copiedPre.textContent).not.toContain('line_29999')
  expect(copiedPre.style.height).toBe('600000px')
  expect(pre.querySelectorAll('span')).toHaveLength(30000)
  expect([scroller.scrollTop, pre.scrollTop, pre.scrollLeft]).toEqual([200000, 0, 37])
})
```

Also parameterize the same fixture for an internally scrolled `pre` (`height:192px; overflow:auto`, `pre.scrollTop=200000`), nonzero padding/border, partial first line, leading/trailing empty lines, nonzero horizontal scroll, small highlighted code (must remain highlighted), and a large pre outside the visible portion of an otherwise retained article (must retain its shell without traversing code children). Assertions must inspect the actual cloned content/position and visited source nodes. The wrapped case below is deliberately **not** allowed to use the line-index adapter.

Add real-browser tests with the Task 1 fixtures:

```ts
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
```

`FreshAgentActivityStrip` initially renders only its summary when `expandTools` is false. Its real `Toggle activity details` disclosure exposes the tool, and a single tool automatically opens its output (`singleToolExpand`); do not click `Bash tool call` closed. DOM click is appropriate solely to configure a hidden fixture, before observation/capture. The width-520 case also uses a real split pane, rather than treating a narrow browser alone as split coverage.

Add named browser cases `giant natural-height code captures middle and bottom visible lines` and `giant internally scrolled code preserves partial lines and horizontal offset`. Mount `giantCode()`, assert its **actual highlighted descendants** count is at least 30,000, and position the transcript midway through the pre, then near its bottom. The natural-height case leaves `pre.scrollTop === 0`; the internal case sets test-owned fixed pre height/overflow and literal inner offsets before capture. Both exercise blank lines and tab indentation, partial vertical clipping, and horizontal scroll. Select expected visible lines from **live browser Range glyph boxes**, without reusing production's line-height/origin formula; retain the source pre footprint and all live offsets.

For a browser image oracle that permits lost syntax colors, build a separate **small** reference fixture from those source-grounded visible plain-text lines, including intervening blanks/tabs, using the source's font, foreground, padding/border, width and background. Align a reference glyph to the independently measured live glyph, then verify first/middle/last visible glyph coordinates independently before the exact PNG comparison. Capture this small document with unmodified html2canvas; never copy the giant highlighted subtree. Record captured element count from the unit traversal; browser capture must meet the same 10-second bound. Keep this reference builder local to the spec; do not add a production plain-code mode or test hook.

Use this local browser oracle and test implementation; unlike the production adapter it copies the browser's full computed style of just two elements into a disposable document. It never imports highlighted descendants or clones the giant source document:

```ts
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
      const root = d.createElement('div'), copy = d.createElement('pre'), text = d.createElement('span')
      const width = clip.right - clip.left, height = clip.bottom - clip.top
      root.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px`
      const apply = (dest: HTMLElement, style: CSSStyleDeclaration) => {
        for (const property of style) dest.style.setProperty(property, style.getPropertyValue(property))
      }
      apply(copy, ps); apply(text, cs)
      Object.assign(copy.style, { visibility: 'visible', position: 'absolute', boxSizing: 'border-box', margin: '0',
        left: `${r.left - clip.left}px`, top: `${r.top - clip.top}px`, width: `${r.width}px`, height: `${r.height}px`, overflow: 'hidden' })
      Object.assign(text.style, { visibility: 'visible', position: 'absolute', margin: '0', padding: '0', border: '0', whiteSpace: 'pre',
        top: '0', left: '0' })
      text.textContent = visibleText; copy.appendChild(text); root.appendChild(copy); d.body.appendChild(root)
      await d.fonts.ready
      const glyphRect = (glyph: typeof visible[number]) => {
        const at = lines.slice(first, glyph.line).reduce((n, line) => n + line.length + 1, 0) + glyph.char
        const range = d.createRange()
        range.setStart(text.firstChild!, at); range.setEnd(text.firstChild!, at + 1)
        return range.getBoundingClientRect()
      }
      const anchor = visible[0], initial = glyphRect(anchor), rootBox = root.getBoundingClientRect()
      text.style.top = `${anchor.top - clip.top - (initial.top - rootBox.top)}px`
      text.style.left = `${anchor.left - clip.left - (initial.left - rootBox.left)}px`
      const sentinels = [visible[0], visible[Math.floor(visible.length / 2)], visible.at(-1)!].map((glyph) => {
        const actual = glyphRect(glyph), bounds = root.getBoundingClientRect()
        return { line: glyph.line, sourceTop: glyph.top - clip.top, referenceTop: actual.top - bounds.top,
          sourceLeft: glyph.left - clip.left, referenceLeft: actual.left - bounds.left }
      })
      const canvas = await (window as any).html2canvas(root, { backgroundColor: null, scale: Math.max(1, devicePixelRatio || 1), logging: false })
      const crop = { x: 0, y: 0, width, height }
      return { base64: canvas.toDataURL('image/png').split(',')[1], crop, crops: [crop], width: canvas.width, height: canvas.height,
        actualCrop: { x: clip.left - p.left, y: clip.top - p.top, width, height }, first, last, sentinels,
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
    expect(await pre.locator('*').count()).toBeGreaterThanOrEqual(30000)
    for (const fraction of [0.53, 0.97]) {
      await pre.evaluate((pre: HTMLElement, { internal, fraction }) => {
        const scroll = pre.closest<HTMLElement>('[data-context="fresh-agent-transcript"]')!
        if (internal) {
          pre.style.height = '192px'; pre.style.overflow = 'auto'
          pre.scrollTop = (pre.scrollHeight - pre.clientHeight) * fraction + 3
          scroll.scrollTop = 0
        } else {
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
      for (const glyph of expected.sentinels) {
        expect(glyph.referenceTop).toBeCloseTo(glyph.sourceTop, 2)
        expect(glyph.referenceLeft).toBeCloseTo(glyph.sourceLeft, 2)
      }
      expect(expected.offsets[1] === 0).toBe(!internal)
      const before = await pre.evaluate((pre: HTMLElement) => ({ height: pre.getBoundingClientRect().height, top: pre.scrollTop, left: pre.scrollLeft }))
      const started = Date.now(), shot = await png(page, serverInfo, 'pane', fixture.paneId)
      expect(Date.now() - started).toBeLessThan(10000)
      expect((await compare(page, shot.base64, expected)).different).toBe(0)
      expect(await pre.evaluate((pre: HTMLElement) => ({ height: pre.getBoundingClientRect().height, top: pre.scrollTop, left: pre.scrollLeft }))).toEqual(before)
      expect(await pre.evaluate((pre: HTMLElement) => [pre.closest<HTMLElement>('[data-context="fresh-agent-transcript"]')!.scrollTop, pre.scrollTop, pre.scrollLeft])).toEqual(expected.offsets)
      await testInfo.attach(`code-${internal}-${fraction}-actual`, { body: Buffer.from(shot.base64, 'base64'), contentType: 'image/png' })
      await testInfo.attach(`code-${internal}-${fraction}-reference`, { body: Buffer.from(expected.base64, 'base64'), contentType: 'image/png' })
    }
  })
}
```

The oracle uses a tag check instead of a cross-realm constructor for stylesheet links and reports stylesheet failures clearly. The iframe is test-owned, created after source mounting and removed in `finally`; it is never present during the production capture.

- [ ] **Step 2: Run tests and verify intended failure**

```bash
pnpm run test:vitest run test/unit/client/ui-screenshot.test.ts test/unit/client/lib/screenshot-capture-env.test.ts --config config/vitest/vitest.config.ts
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/pane-viewport-screenshot.spec.ts
```

Expected: giant-code unit fails because highlighted descendants are visited; giant browser capture fails its bounded work/content criterion on Task 1 alone. Wrapped-output references may pass immediately, proving that preserving the existing plain text is correct; retain this evidence rather than introducing wrapping machinery just to change code.

- [ ] **Step 3: Add the minimal production implementation**

Add the following private adapter types/functions to the same helper. Keep thresholds internal implementation constants. Do not adapt wrapped plain tool output, DiffView, Monaco, terminal canvases, or iframe documents. `clipFor` includes **all actual ancestor overflow clipping**, so a naturally tall pre uses the transcript's clip rather than merely its own `scrollTop`. It snapshots all source values synchronously; the clone phase must not reread live geometry.

```ts
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
  let clip = intersection(viewport(pre), target.getBoundingClientRect())
  const view = pre.ownerDocument.defaultView!
  for (let parent = pre.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent)
    const box = viewport(parent)
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
    const type = view.getComputedStyle(code)
    const lineHeight = parseFloat(type.lineHeight)
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
        [key, type[key as keyof CSSStyleDeclaration] as string])),
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
```

Use a short plain-text replacement even if the large pre is outside the clip within a retained row; its shell still keeps the full source footprint. This avoids cloning a giant offscreen code block merely because its containing article crosses the viewport. A single enormous physical line retains its visible horizontal origin without inventing horizontal text truncation. Its linear text copy is permitted; per-token styled cloning is the cost being removed. Small highlighted code is untouched. Plain wrapped tool text has no child elements and is immediately untouched.

Extend `TranscriptPlan` with `code: RowCodePlan[]`; construct it for `rows.slice(first, end)` by calling `prepareCode(row, target, omitted)` synchronously. In `onclone`, after scroller count/identity validation and **before** measuring any spacer, save `const retained = Array.from(copy.children) as HTMLElement[]` and apply each code plan to its corresponding retained row. The saved ordering is within the reduced tree, so omitted history does not change correlation. Then perform Task 1's spacer geometry repair and literal transcript scroll restoration. Do not touch the source rows or add marker attributes.

Ordinary pre's literal nested scroll offsets continue to be restored by html2canvas's own cloner. The code adapter intentionally uses equivalent clone-only text translation because its giant internal extent is no longer represented by highlighted children. The browser tests must prove both kinds of scrolling and prevent double subtraction.

- [ ] **Step 4: Run focused tests**

```bash
pnpm run test:vitest run test/unit/client/ui-screenshot.test.ts test/unit/client/lib/screenshot-capture-env.test.ts --config config/vitest/vitest.config.ts
pnpm run typecheck:client
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/pane-viewport-screenshot.spec.ts
```

Expected: PASS, including every named Task 1 case; highlighted descendants never reach the cloner, natural-height and internal-scroll code capture the correct current lines/offsets, and both wrapped-output widths exactly match full html2canvas. A wrapped reference mismatch is a correctness failure to diagnose in clone geometry/scroll, not permission to use source-line slicing or discard visible content.

- [ ] **Step 5: Refactor while green**

Keep code replacement and transcript spacers as two small private operations in the one focused helper. Remove unused saved geometry, normalize numeric style reads once, and consolidate repeated clone validation errors where that improves clarity. Review whether the adapter threshold can be simpler without applying to wrapped text or small highlighted blocks. Re-run focused units and the new browser spec after any refactor; inspect representative ordinary/wrapped/code PNGs and line origins.

- [ ] **Step 6: Run impacted-test verification and final branch gate**

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --config=default test/unit/client/ui-screenshot.test.ts test/unit/client/lib/screenshot-capture-env.test.ts
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/pane-viewport-screenshot.spec.ts test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts test/e2e-browser/specs/browser-pane-screenshot.spec.ts
pnpm run typecheck:client
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='viewport screenshot branch validation' pnpm run check
```

Expected: the impacted cloud suites/typecheck PASS and all new named browser tests actually run under the configured cloud config. The broad gate should introduce no new failures; if the separately recorded FreshAgentView base failure persists, classify it explicitly against the unchanged immutable base receipt rather than fixing unrelated code, weakening coverage, or claiming an all-green suite. Inspect first-attempt failures and retain meaningful recovered retry evidence. A configured cloud failure cannot silently fall back to local.

This final broad check is repository completion validation, not a reason to add unrelated fixes. Keep retained results needed for review in this worktree's configured output paths and remove only task-owned disposable `.test-tmp` files after use. Shared fixture teardown owns its processes; no production server or port 3001 action is part of verification.

- [ ] **Step 7: Commit this deliverable**

```bash
git add src/lib/screenshot-viewport.ts test/unit/client/ui-screenshot.test.ts test/e2e-browser/specs/pane-viewport-screenshot.spec.ts
git commit -m "fix: capture visible lines of large screenshot code blocks"
```

## Requirement and evidence map

| User requirement or accepted residual | Production outcome and verification |
| --- | --- |
| Useful current viewport from a background pane | Task 1's existing capture path, clone-only reveal, ordinary top/middle/bottom full html2canvas references, independently measured same-source 30k viewport reference including minimap |
| Typical 30,000-element transcript, efficient capture | Task 1 early omitted-root predicate, traversal assertions, actual DOM count, unrelated second huge pane/editor, existing 10-second server deadline plus elapsed assertion and diagnostic heartbeat |
| No switching tabs, stolen focus, live scroll changes | Task 1 live-object/selection assertions and transient browser observations during REST capture; unchanged renderer/iframe cleanup |
| Exclude history before cloning and retain offsets/layout | Task 1 pre-descent behavioral cloner, content-space anchor/top/bottom spacers, first-child exception and exact browser pixels |
| Large highlighted code captures visible lines | Task 2 descendant exclusion and adapter; natural-height/internal-scroll 30k code at middle/bottom, independent live Range glyph positions, blanks/tabs, partial lines, horizontal offset, geometric footprint |
| Simple implementation proportionate to low importance | One helper, two existing html2canvas hooks, no backend/API/settings/dependency/general framework |
| Dedicated worktree, preserve unrelated work, baseline exception separate | Fixed worktree/branch/base, focused commits, parent-owned failure receipt, no unrelated component changes |
| No production deploy/restart or unauthorized PR | No deployment/production commands in either task; push/approval handoff follows AGENTS.md |
| Brief hesitation acceptable | Generous finite capture ceiling; record heartbeat evidence without a zero-delay promise |
| html2canvas accuracy, including its native-pixel differences | Same-browser html2canvas references, never native screenshot golden pixels |
| Large-code syntax color loss acceptable | Only adapted large nonwrapping blocks use source foreground plain text; small blocks retain syntax colors |
| Wrapped tool output requires validation | Task 2 full-reference comparison at two widths including split, a long wrapped physical line/unbroken token, partial outer clip and nonzero inner scroll |

## Planner self-review

The complete supplied User Request block is retained once. Both tasks deliver independently reviewable production behavior and fold their browser proof into the same deliverable; no separate test-only phase is required. Source changes are limited to the preparation helper and main capture/iframe composition, with typed synthetic fixtures and existing API/harness entrypoints. The 30k oracle uses actual source geometry and minimap rather than different fixtures; code-line selection/alignment uses independent live Range glyph positions rather than the adapter formula. Wrapped output opens its real activity disclosure and remains plain wrapped text. Exact ordinary/reference comparisons, the real 10-second deadline, two-frame settling, fresh geometry after awaits, retained iframe count/src/pane guards, and renderer failure/overlap behavior remain covered. Every edited literal, interface, reference, and count has been reconciled with these tasks and the current source. No private proof data, production step, dependency change, source test hook, exceptional iframe lifecycle framework, or unauthorized PR action is introduced.
