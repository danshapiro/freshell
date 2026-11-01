import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

// Render markdown bodies synchronously — the same LazyMarkdown mock the
// transcript's own suite uses, so assertions never race the Suspense chunk.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

// Canonical geometry for this suite (see transcript-minimap-layout.ts):
//   scrollTop=376, scrollHeight=1000, clientHeight=248
//   railHeight = 248 - 48 (MINIMAP_RAIL_BOTTOM_INSET_PX) = 200, scale = 0.2
//   3 user turns (50px rects) -> slot 200/3 = 66.6̅7 per prompt (even
//   spacing: content offsets order but never place ticks); line heights
//   50*0.2 = 10 centered at tops 28.3̅3 / 95 / 161.6̅7; each BUTTON is the
//   hit box — 2x the line (20px) centered on the line at tops 23.3̅3 / 90 /
//   156.6̅7, left -3, width 18 — with an inner paint span at the LINE rect
const SCROLL_TOP = 376
const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 248

const TRANSCRIPT = [
  {
    id: 'u1',
    role: 'user' as const,
    summary: 'First user message here',
    items: [{ id: 'i1', kind: 'text' as const, text: 'First user message here' }],
  },
  {
    id: 'a1',
    role: 'assistant' as const,
    summary: 'reply 1',
    items: [{ id: 'i2', kind: 'text' as const, text: 'A'.repeat(200) }],
  },
  {
    id: 'u2',
    role: 'user' as const,
    summary: 'Second user message here',
    items: [{ id: 'i3', kind: 'text' as const, text: 'Second user message here' }],
  },
  {
    id: 'a2',
    role: 'assistant' as const,
    summary: 'reply 2',
    items: [{ id: 'i4', kind: 'text' as const, text: 'B'.repeat(200) }],
  },
  {
    id: 'u3',
    role: 'user' as const,
    summary: 'Third user message here',
    items: [{ id: 'i5', kind: 'text' as const, text: 'Third user message here' }],
  },
  {
    id: 'a3',
    role: 'assistant' as const,
    summary: 'reply 3',
    items: [{ id: 'i6', kind: 'text' as const, text: 'C'.repeat(200) }],
  },
]

function mockScroll(scroller: HTMLElement, scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  scroller.scrollTop = scrollTop
}

function mockRect(el: Element, top: number, height = 50) {
  el.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
}

/** Rects consistent with SCROLL_TOP=376: content offsets 0 / 300 / 450. */
function mockUserTurnRects(userTurns: NodeListOf<Element> | Element[]) {
  mockRect(userTurns[0], -376)
  mockRect(userTurns[1], -76)
  mockRect(userTurns[2], 74)
}

function setupScrollableTranscript(turns = TRANSCRIPT) {
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  mockUserTurnRects(userTurns)
  // The minimap's synchronous scroll listener recomputes landmark geometry.
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

/** Dense-cluster geometry: scrollHeight 1000, clientHeight 248 -> railHeight
 *  200, scale 0.2. `count` short one-line user turns with 10px rects (the
 *  content offsets are irrelevant under even spacing — only the COUNT
 *  sets the slot pitch): line heights clamp to the density floor
 *  max(min(3, 200/count), 10*0.2). At the default count 60 the slot pitch
 *  200/60 = 3.3̅3 is sub-clickable, so the clickability pass joins EVERY
 *  consecutive pair into ONE dense mega-run spanning the whole rail
 *  (line tops i*10/3 + 1/6 at h 3): its open-list target covers rail
 *  1/6 .. 599/3 and its menu lists every prompt. At smaller counts
 *  (slot >= 4, e.g. the old 4/30-prompt seeds) the same fixture now yields
 *  lone dense singletons instead — density comes from the slot pitch, not
 *  from bunched offsets. Count 120 (the bounded-menu fixtures) thins the
 *  slot to 5/3 for an even denser whole-rail run. */
function setupDenseClusterTranscript(count = 60) {
  const turns = Array.from({ length: count }, (_, i) => ({
    id: `du${i}`,
    role: 'user' as const,
    summary: `Dense prompt number ${i + 1}`,
    items: [{ id: `di${i}`, kind: 'text' as const, text: `Dense prompt number ${i + 1}` }],
  }))
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, 0, 1000, 248)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  userTurns.forEach((el, i) => mockRect(el, 500 + i * 10, 10))
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

/** Evenly-dense isolated-tick geometry (the lone sub-4px tick fixture):
 *  scrollHeight 10000, clientHeight 248 -> railHeight 200, scale 0.02.
 *  Fifty short user turns (150px rects): slot 200/50 = 4, line heights
 *  clamp to max(min(3, 4), 150*0.02) = 3, centered at tops 4i + 0.5. The
 *  clickability pass joins nothing (4.5 < 4.5 is false) — 50 dense
 *  SINGLETON clusters: every tick is a lone sub-4px tick, none collides
 *  into a multi-member run. Each button gets the loneDense hit box:
 *  max(2*3, 4) = 6 clamped to the 4px slot -> {4i, 4}. */
function setupEvenlyDenseTranscript() {
  const turns = Array.from({ length: 50 }, (_, i) => ({
    id: `eu${i}`,
    role: 'user' as const,
    summary: `Even dense prompt number ${i + 1}`,
    items: [{ id: `ei${i}`, kind: 'text' as const, text: `Even dense prompt number ${i + 1}` }],
  }))
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, 0, 10000, 248)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  userTurns.forEach((el, i) => mockRect(el, i * 200, 150))
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

const topOf = (el: HTMLElement) => parseFloat(el.style.top)
const heightOf = (el: HTMLElement) => parseFloat(el.style.height)
const leftOf = (el: HTMLElement) => parseFloat(el.style.left)
const widthOf = (el: HTMLElement) => parseFloat(el.style.width)

/** Capturable ResizeObserver stub: records callbacks PER OBSERVED TARGET so
 * tests can fire exactly the callbacks a specific element would receive on a
 * real resize (the global jsdom stub in test/setup/dom.ts is a silent no-op).
 * Target-scoped firing is what makes the article-observation test
 * load-bearing: the scroller observer's callback is never fired there. */
const resizeCallbacksByTarget = new Map<Element, Array<() => void>>()
class CapturingResizeObserver {
  private readonly fire = () => this.cb()
  constructor(private readonly cb: () => void) {}
  observe(el: Element) {
    resizeCallbacksByTarget.set(el, [...(resizeCallbacksByTarget.get(el) ?? []), this.fire])
  }
  unobserve() {}
  disconnect() {}
}

describe('FreshAgentTranscript minimap rail', () => {
  afterEach(() => { vi.unstubAllGlobals(); cleanup() })

  it('keeps prompt markers without a second scrollbar-shaped viewport band', () => {
    setupScrollableTranscript()

    const minimap = screen.getByRole('group', { name: 'Transcript minimap' })
    expect(within(minimap).getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)
    expect(screen.queryByTestId('transcript-minimap-viewport')).not.toBeInTheDocument()
  })

  it('renders one tick per user turn, evenly spaced with 2x-height hit boxes and centered paint spans', () => {
    setupScrollableTranscript()

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(3)
    expect(ticks[0]).toHaveAttribute('aria-label', 'Jump to prompt: First user message here')
    expect(ticks[1]).toHaveAttribute('aria-label', 'Jump to prompt: Second user message here')
    expect(ticks[2]).toHaveAttribute('aria-label', 'Jump to prompt: Third user message here')
    // Even spacing: slot 200/3 = 66.6̅7, line heights 50*0.2 = 10 centered
    // at line tops 28.3̅3 / 95 / 161.6̅7. Each BUTTON is the hit box — 2x
    // the line (20px), centered on the line: tops 23.3̅3 / 90 / 156.6̅7.
    expect(topOf(ticks[0])).toBeCloseTo(23.3333333, 5)
    expect(topOf(ticks[1])).toBeCloseTo(90, 5)
    expect(topOf(ticks[2])).toBeCloseTo(156.6666667, 5)
    expect(heightOf(ticks[0])).toBeCloseTo(20, 5)
    // Horizontal growth: the 12px rail column gets 50% padding per side —
    // an 18px hit box (left -3, width 18) centered on it.
    expect(leftOf(ticks[0])).toBe(-3)
    expect(widthOf(ticks[0])).toBe(18)
    // The painted line is an inner aria-hidden span at the LINE rect,
    // centered inside the button: top 28.3̅3 - 23.3̅3 = 5, height 10.
    const paint = ticks[0].querySelector('span')
    expect(paint).not.toBeNull()
    expect(paint).toHaveAttribute('aria-hidden', 'true')
    expect(topOf(paint as HTMLElement)).toBeCloseTo(5, 5)
    expect(heightOf(paint as HTMLElement)).toBeCloseTo(10, 5)
  })

  it('clicking a tick scrolls that prompt into view', () => {
    const { userTurns } = setupScrollableTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[1].scrollIntoView = scrollIntoViewSpy

    fireEvent.click(screen.getByRole('button', { name: 'Jump to prompt: Second user message here' }))

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
  })

  it('previews the prompt in a tooltip on hover and on focus', () => {
    setupScrollableTranscript()
    const tick = screen.getByRole('button', { name: 'Jump to prompt: Second user message here' })

    fireEvent.mouseEnter(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Second user message here')
    fireEvent.mouseLeave(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Keyboard parity: the tooltip component also opens on focus.
    fireEvent.focus(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Second user message here')
    fireEvent.blur(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('truncates long prompts in the aria-label (60) and tooltip (120)', () => {
    const longPrompt = 'A'.repeat(130)
    const turns = [
      { id: 'u1', role: 'user' as const, summary: longPrompt, items: [{ id: 'i1', kind: 'text' as const, text: longPrompt }] },
      { id: 'a1', role: 'assistant' as const, summary: 'reply 1', items: [{ id: 'i2', kind: 'text' as const, text: 'B'.repeat(200) }] },
      { id: 'u2', role: 'user' as const, summary: 'Short second prompt', items: [{ id: 'i3', kind: 'text' as const, text: 'Short second prompt' }] },
    ]
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    mockRect(userTurns[1], 74)
    fireEvent.scroll(scroller)

    const tick = screen.getByRole('button', { name: `Jump to prompt: ${'A'.repeat(59)}…` })
    expect(tick).toHaveAttribute('aria-label', `Jump to prompt: ${'A'.repeat(59)}…`)
    fireEvent.mouseEnter(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${'A'.repeat(119)}…`)
  })

  it('wraps long unbroken tokens in the hover preview (break-words)', () => {
    setupScrollableTranscript()
    const tick = screen.getByRole('button', { name: 'Jump to prompt: Second user message here' })

    fireEvent.mouseEnter(tick)
    // jsdom cannot observe visual wrapping; this class-presence pin plus the
    // e2e range assertion (transcript-minimap.spec.ts) carry the real behavior.
    expect(screen.getByRole('tooltip')).toHaveClass('break-words')
    fireEvent.mouseLeave(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('recomputes ticks when the transcript grows', () => {
    const utils = setupScrollableTranscript()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    const grown = [
      ...TRANSCRIPT,
      { id: 'u4', role: 'user' as const, summary: 'Fourth user message here', items: [{ id: 'i7', kind: 'text' as const, text: 'Fourth user message here' }] },
      { id: 'a4', role: 'assistant' as const, summary: 'reply 4', items: [{ id: 'i8', kind: 'text' as const, text: 'D'.repeat(200) }] },
    ]
    // NO scroll event and NO extra geometry mocks after the rerender: the
    // transcriptSignature effect alone must re-measure. The new article's
    // real jsdom-zero rect places it at content offset 0 - 0 + scrollTop
    // (376) with height 0, sorted between Second (300) and Third (450).
    // The re-measure re-SLOTS every prompt: N=4 -> slot 50; the fourth's
    // line clamps to the 3px floor, centered at 2*50 + (50-3)/2 = 123.5;
    // as a dense singleton (3 < 4) its button gets the loneDense hit box
    // max(2*3, 4) = 6 centered on line center 125 -> top 122. If the
    // signature recomputation effect were removed, this test fails —
    // nothing else fires.
    utils.rerender(<FreshAgentTranscript turns={grown} />)

    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(4)
    const fourth = screen.getByRole('button', { name: 'Jump to prompt: Fourth user message here' })
    expect(topOf(fourth)).toBeCloseTo(122, 5)
    expect(heightOf(fourth)).toBeCloseTo(6, 5)
  })

  it('hides the rail when the transcript fits the viewport', () => {
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 200, CLIENT_HEIGHT) // scrollHeight 200 <= clientHeight 248
    mockRect(scroller, 0)
    fireEvent.scroll(scroller)

    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
  })

  it('hides the rail and its measurement work when showTranscriptMinimap is false', () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} showTranscriptMinimap={false} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockUserTurnRects(userTurns)
    fireEvent.scroll(scroller)

    // The rail is absent under geometry that renders it when the setting is
    // on (this suite's canonical mocks) — the setting, not geometry, hid it.
    expect(screen.queryByRole('group', { name: 'Transcript minimap' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    // "And its work": the unmounted rail registered no ResizeObserver
    // subscriptions (fresh elements cannot have stale entries in the shared
    // per-target callback map).
    for (const el of [scroller, ...Array.from(scroller.children)]) {
      expect(resizeCallbacksByTarget.get(el)).toBeUndefined()
    }
    // The glom chip still works — the shared sweep survives the rail's absence.
    expect(screen.getByRole('button', { name: 'Jump to your message: Second user message here' })).toBeInTheDocument()
  })

  it('renders a lone tick for a single-prompt transcript (no < 2 gate)', () => {
    const utils = render(<FreshAgentTranscript turns={[TRANSCRIPT[0], TRANSCRIPT[1]]} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    fireEvent.scroll(scroller)

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toHaveAttribute('aria-label', 'Jump to prompt: First user message here')
  })

  it('re-measures when an article resizes (disclosure toggle) with no signature change', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const { scroller, userTurns } = setupScrollableTranscript()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    // A disclosure inside the SECOND user article expands, growing its rect
    // 50px -> 250px at the same content offset — under even spacing the
    // slot pitch is fixed by the prompt count, so the observable
    // re-measure output is the tick's LINE height: 250 * 0.2 = 50,
    // centered at 66.6̅7 + (66.6̅7 - 50)/2 = 75. The hit box clamps to the
    // slot: min(2*50, 66.6̅7) = 66.6̅7 centered on line center 100 ->
    // button top 66.6̅7; the paint span (the LINE rect) sits at 75 -
    // 66.6̅7 = 8.3̅3 with height 50.
    mockRect(userTurns[1], -76, 250)
    // Fire ONLY the callbacks registered for turn articles — never the
    // scroller observer's — so this test fails if article observation is
    // removed (nothing would fire) instead of passing via the scroller
    // path. act() wraps the callbacks: they setState synchronously.
    await act(async () => {
      for (const el of scroller.querySelectorAll('[data-turn-role]')) {
        for (const fire of resizeCallbacksByTarget.get(el) ?? []) fire()
      }
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    const paint = ticks[1].querySelector('span') as HTMLElement
    expect(heightOf(ticks[1])).toBeCloseTo(200 / 3, 5)
    expect(topOf(paint)).toBeCloseTo(25 / 3, 5)
    expect(heightOf(paint)).toBeCloseTo(50, 5)
  })

  it('re-measures when the rolled-back history disclosure resizes', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const rolledBack = [
      { id: 'r1', turnId: 'r1', role: 'user' as const, summary: 'rolled prompt one', items: [{ id: 'r1i', kind: 'text' as const, text: 'rolled prompt one' }], restorable: false },
      { id: 'r2', turnId: 'r2', role: 'user' as const, summary: 'rolled prompt two', items: [{ id: 'r2i', kind: 'text' as const, text: 'rolled prompt two' }], restorable: false },
    ]
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} rolledBackTurns={rolledBack} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockUserTurnRects(userTurns)
    fireEvent.scroll(scroller)
    const section = screen.getByRole('region', { name: 'Rolled back turns' })

    // The disclosure expands OUTSIDE the turn articles: the scrollable
    // content grows (scrollHeight 1000 -> 1200) while the article rects
    // keep their content offsets. Under even spacing the offsets place
    // nothing, but the scale drop (200/1000 = 0.2 -> 200/1200 = 1/6)
    // re-scales every LINE height: 50/6 = 8.3̅3, centered at i*66.6̅7 +
    // (66.6̅7 - 8.3̅3)/2 = i*66.6̅7 + 29.1̅6. Fire ONLY the section's
    // callbacks — not the articles', not the scroller's — so this test
    // fails unless non-article children are observed.
    mockScroll(scroller, SCROLL_TOP, 1200, CLIENT_HEIGHT)
    await act(async () => {
      for (const fire of resizeCallbacksByTarget.get(section) ?? []) fire()
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    const paint = ticks[1].querySelector('span') as HTMLElement
    // Second line: top 66.6̅7 + 29.1̅6 = 95.8̅3, height 8.3̅3 = 25/3; its
    // 2x hit box (16.6̅7) centers on line center 100 -> button top 91.6̅7.
    expect(topOf(ticks[1])).toBeCloseTo(91.6666667, 5)
    expect(heightOf(paint)).toBeCloseTo(25 / 3, 5)
  })

  it('re-measures when the scroller itself resizes (pane resize re-scales the rail)', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const { scroller } = setupScrollableTranscript()
    const initialTicks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(initialTicks[1])).toBeCloseTo(90, 5)
    expect(topOf(initialTicks[2])).toBeCloseTo(156.6666667, 5)

    // Pane resize: only the scroller's clientHeight grows (248 -> 298). The
    // content is unchanged (scrollHeight 1000, scrollTop 376) and the article
    // rects keep their content offsets (0/300/450) — only the rail geometry
    // changes: railHeight 250 -> slot 250/3 = 83.3̅3, scale 0.25 -> line
    // heights 12.5 centered at i*83.3̅3 + 35.41̅6; hit boxes 2x line (25)
    // centered on the lines at tops 29.1̅6 / 112.5 / 195.8̅3.
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, 298)
    // Fire ONLY the callbacks registered for the scroller — never the
    // articles' or the disclosure section's — so this test fails if the
    // scroller observation is removed (nothing would fire) instead of
    // passing via another path. act() wraps the callbacks: they setState
    // synchronously.
    await act(async () => {
      for (const fire of resizeCallbacksByTarget.get(scroller) ?? []) fire()
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(ticks[0])).toBeCloseTo(29.1666667, 5)
    expect(topOf(ticks[1])).toBeCloseTo(112.5, 5)
    expect(topOf(ticks[2])).toBeCloseTo(195.8333333, 5)
  })

  it('opens topmost ticks downward (side bottom) and lower ticks upward (side top)', () => {
    setupScrollableTranscript()
    // railHeight 200 -> top-quarter threshold 50. Tick 0's LINE top
    // (28.3̅3) is in the top quarter and must open BELOW its tick; ticks 1
    // (line top 95) and 2 (161.6̅7) open above. tooltip.tsx:89-95 sets side
    // "bottom" top = rect.bottom + sideOffset (positive here) and side
    // "top" top = rect.top - height - sideOffset (negative here).
    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    fireEvent.mouseEnter(ticks[0])
    expect(parseFloat(screen.getByRole('tooltip').style.top)).toBeGreaterThan(0)
    fireEvent.mouseLeave(ticks[0])
    fireEvent.mouseEnter(ticks[1])
    expect(parseFloat(screen.getByRole('tooltip').style.top)).toBeLessThan(0)
  })

  it('renders no rail under default jsdom geometry (protects the rest of the suite)', () => {
    // No geometry mocks: clientHeight/scrollHeight are 0, so the rail must
    // stay hidden. This is the invariant that keeps every pre-existing
    // transcript test free of minimap buttons.
    render(<FreshAgentTranscript turns={TRANSCRIPT} />)
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
  })

  it('runs ONE shared landmark sweep per scroll event, feeding both the glom chip and the rail', () => {
    const { scroller } = setupScrollableTranscript()
    // Both consumers render from the shared sweep: the glom chip names the
    // last prompt above the viewport; the rail shows all three ticks.
    expect(screen.getByRole('button', { name: /Jump to your message/ })).toHaveTextContent('Second user message here')
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    const sweepQuery = vi.spyOn(scroller, 'querySelectorAll')
    const scrollerRect = vi.spyOn(scroller, 'getBoundingClientRect')
    fireEvent.scroll(scroller)

    // ONE querySelectorAll('[data-turn-role="user"]') per scroll event — the
    // pre-refactor code ran two (recomputeGlom + the minimap's own sweep).
    const landmarkQueries = sweepQuery.mock.calls.filter(
      ([selector]) => selector === '[data-turn-role="user"]',
    )
    expect(landmarkQueries).toHaveLength(1)
    // One scroller rect read per sweep (shared), not one per consumer.
    expect(scrollerRect).toHaveBeenCalledTimes(1)
    // Both consumers updated from that single sweep.
    expect(screen.getByRole('button', { name: 'Jump to your message: Second user message here' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    sweepQuery.mockRestore()
    scrollerRect.mockRestore()
  })

  it('renders one open-list target over the dense mega-cluster; every per-prompt tick stays in the DOM', () => {
    setupDenseClusterTranscript()

    // The one-tick-per-prompt contract: all sixty tick buttons remain, fully
    // keyboard/screen-reader accessible as today.
    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(60)
    // The slot pitch 200/60 = 3.3̅3 is sub-clickable, so the whole rail is
    // ONE dense run: exactly one hit-target button over it, spanning
    // cluster top 1/6 with height min(max(599/3, 4), 200 - 1/6) = 599/3.
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })
    expect(topOf(clusterTarget)).toBeCloseTo(1 / 6, 5)
    expect(heightOf(clusterTarget)).toBeCloseTo(599 / 3, 5)
    expect(clusterTarget).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('keeps normal-density clusters on per-tick behavior — no open-list targets', () => {
    setupScrollableTranscript()
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)
  })

  it('opens a ContextMenu listing every prompt in the dense cluster; selecting one jumps to it', () => {
    const { userTurns } = setupDenseClusterTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[2].scrollIntoView = scrollIntoViewSpy

    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-60 — open list' }))

    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(60)
    expect(items[0]).toHaveTextContent('Dense prompt number 1')
    expect(items[59]).toHaveTextContent('Dense prompt number 60')

    fireEvent.click(items[2])
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    // ContextMenu closes itself after a selection.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('gives a lone sub-4px tick a slot-clamped hit target with a 3px painted span and a direct jump (no menu)', () => {
    const { userTurns } = setupEvenlyDenseTranscript()
    const firstTick = screen.getByRole('button', { name: 'Jump to prompt: Even dense prompt number 1' })

    // The loneDense hit wants max(2*3, 4) = 6px, but the 4px slot clamps
    // it to 4 — the box fills the prompt's uniform slot, top 0 (line
    // center 2 minus half the box), abutting (never overlapping) its
    // neighbor's box at top 4...
    expect(topOf(firstTick)).toBeCloseTo(0, 5)
    expect(heightOf(firstTick)).toBeCloseTo(4, 5)
    // ...while the painted line is an inner aria-hidden span at the tick's
    // visual 3px height, centered in the box at +0.5.
    const painted = firstTick.querySelector('span')
    expect(painted).not.toBeNull()
    expect(painted).toHaveAttribute('aria-hidden', 'true')
    expect(topOf(painted as HTMLElement)).toBeCloseTo(0.5, 5)
    expect(heightOf(painted as HTMLElement)).toBeCloseTo(3, 5)

    // No menu anywhere — the target is unambiguous; clicking jumps directly.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const scrollIntoViewSpy = vi.fn()
    userTurns[0].scrollIntoView = scrollIntoViewSpy
    fireEvent.click(firstTick)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('previews the member prompt under the pointer from the dense cluster target', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })
    // The mocked rect (top 100) is the pointer's coordinate frame:
    // railY = cluster.top + (clientY - rect.top) = 1/6 + 4 = 4.1̅6; member
    // bands sit at line tops i*10/3 + 1/6, so the LAST band at or above
    // 4.1̅6 is member 1 (3.5 .. 6.8̅3) — 'Dense prompt number 2' (member
    // indexes are 0-based).
    mockRect(clusterTarget, 100)
    fireEvent.mouseEnter(clusterTarget, { clientY: 104 })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 2')
  })

  it('updates the cluster preview when the pointer moves to another member band', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })
    mockRect(clusterTarget, 100)
    fireEvent.mouseEnter(clusterTarget, { clientY: 101 }) // railY 1.1̅6 -> member 0 band (1/6..3.5)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 1')
    fireEvent.mouseMove(clusterTarget, { clientY: 107 }) // railY 7.1̅6 -> member 2 band (6.8̅3..10.1̅6)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 3')
  })

  it('clears the cluster hover preview on mouse leave', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })
    mockRect(clusterTarget, 100)
    fireEvent.mouseEnter(clusterTarget, { clientY: 104 })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Dense prompt number 2')
    fireEvent.mouseLeave(clusterTarget)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  // Cluster-opener a11y/focus: the opener is a real <button> in DOM order,
  // so keyboard users reach it natively and Enter/Space drive the same click
  // path as the pointer. The menu primitive moves focus into the menu and
  // never restores it itself (ContextMenu.tsx), so the minimap must. (The
  // primitive's initial rAF item-focus does not run synchronously; these
  // assertions run inside fireEvent's act() - Global Constraints note.)
  it('expands the cluster opener while its menu is open and restores aria-expanded on selection', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })
    expect(clusterTarget).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(clusterTarget)
    expect(clusterTarget).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu')

    // Selection closes the menu and flips the opener back to collapsed.
    fireEvent.click(within(menu).getAllByRole('menuitem')[0])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(clusterTarget).toHaveAttribute('aria-expanded', 'false')
  })

  it('restores focus to the cluster opener after selecting a menu item', () => {
    const { userTurns } = setupDenseClusterTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[3].scrollIntoView = scrollIntoViewSpy
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })

    fireEvent.click(clusterTarget)
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getAllByRole('menuitem')[3])
    // The selection still jumps...
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // ...and focus lands back on the opener, not stranded on body.
    expect(document.activeElement).toBe(clusterTarget)
  })

  it('closes the cluster menu on Escape and restores focus to the opener', () => {
    setupDenseClusterTranscript()
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-60 — open list' })
    fireEvent.click(clusterTarget)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(clusterTarget)
  })

  it('keeps a lone dense tick\'s hit box inside the rail — the slot clamp replaces the old rail-bottom overhang', () => {
    // rail 100 (clientHeight 148), scrollHeight 10000 -> scale 0.01; N=4 ->
    // slot 25, effectiveMin min(3, 25) = 3 floors every 200px article's
    // line (200*0.01 = 2) at 3px, centered at tops i*25 + 11 = 11 / 36 /
    // 61 / 86. Pitch 25 >= 4: every run is a singleton and every tick is
    // dense (3 < 4) — four LONE sub-4px ticks. The last tick's loneDense
    // hit (6px) fits its slot with room to spare: centered on line center
    // 87.5 at top 84.5, bottom 90.5 <= rail 100 — no overhang to clamp.
    // The old 4px-floor overhang (97 + 4 > 100) is structurally gone: a
    // hit can never exceed its slot, and the last slot ends at the rail
    // bottom.
    const turns = Array.from({ length: 4 }, (_, i) => ({
      id: `bu${i}`,
      role: 'user' as const,
      summary: `Bottom prompt number ${i + 1}`,
      items: [{ id: `bi${i}`, kind: 'text' as const, text: `Bottom prompt number ${i + 1}` }],
    }))
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 10000, 148)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    userTurns.forEach((el, i) => mockRect(el, [0, 4000, 8000, 9800][i], 200))
    fireEvent.scroll(scroller)

    // All-lone geometry: no multi-member run anywhere.
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()
    const last = screen.getByRole('button', { name: 'Jump to prompt: Bottom prompt number 4' })
    expect(topOf(last)).toBeCloseTo(84.5, 5)
    // min(max(2*3, 4), 25) = 6: the loneDense hit, in-bounds.
    expect(heightOf(last)).toBeCloseTo(6, 5)
    expect(topOf(last) + heightOf(last)).toBeLessThanOrEqual(100)
    const lastPaint = last.querySelector('span')
    expect(lastPaint).not.toBeNull()
    expect(lastPaint).toHaveAttribute('aria-hidden', 'true')
    // The paint span is the LINE rect relative to the button: 86 - 84.5.
    expect(topOf(lastPaint as HTMLElement)).toBeCloseTo(1.5, 5)
    expect(heightOf(lastPaint as HTMLElement)).toBeCloseTo(3, 5)
    // The predecessor gets the same 6px loneDense box (line 61, center
    // 62.5 -> top 59.5): every prompt's hit stays uniform.
    const predecessor = screen.getByRole('button', { name: 'Jump to prompt: Bottom prompt number 3' })
    expect(topOf(predecessor)).toBeCloseTo(59.5, 5)
    expect(heightOf(predecessor)).toBeCloseTo(6, 5)
  })

  it('spans the dense mega-run\'s open-list target across the rail without overhanging it', () => {
    // rail 100 (clientHeight 148), scrollHeight 10000 -> scale 0.01; 26
    // one-line prompts (200px article rects): slot 100/26 = 50/13 = 3.8̅5 <
    // 4, so every consecutive pair joins — the whole rail is ONE dense
    // mega-run (the all-prompts cluster even spacing produces at
    // sub-clickable pitch), line heights floored at 3, centered at tops
    // i*50/13 + 11/26. The run spans cluster top 11/26 with height
    // 1289/13; the target height min(max(1289/13, 4), 100 - 11/26)
    // keeps it 1289/13 — its bottom lands 11/26 inside the rail edge,
    // never overhanging. The old bunched-at-the-rail-bottom fixture no
    // longer exists: offsets cannot bunch under even spacing.
    const turns = Array.from({ length: 26 }, (_, i) => ({
      id: `cu${i}`,
      role: 'user' as const,
      summary: `Clamp prompt number ${i + 1}`,
      items: [{ id: `ci${i}`, kind: 'text' as const, text: `Clamp prompt number ${i + 1}` }],
    }))
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 10000, 148)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    userTurns.forEach((el, i) => mockRect(el, i * 100, 200))
    fireEvent.scroll(scroller)

    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-26 — open list' })
    expect(topOf(clusterTarget)).toBeCloseTo(11 / 26, 5)
    // min(max(1289/13, 4), 100 - 11/26): the span, in-bounds.
    expect(heightOf(clusterTarget)).toBeCloseTo(1289 / 13, 5)
    expect(topOf(clusterTarget) + heightOf(clusterTarget)).toBeLessThanOrEqual(100)
  })

  it('clears the open cluster menu when geometry hides the rail, so it cannot reappear stale', () => {
    const { scroller } = setupDenseClusterTranscript()
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-60 — open list' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // Collapse geometry the way the fits-viewport test does (scrollHeight
    // <= clientHeight): the shared sweep yields a null layout and the rail -
    // menu included - unmounts. Without the hygiene effect the menu STATE
    // would survive this.
    mockScroll(scroller, 0, 200, CLIENT_HEIGHT)
    mockRect(scroller, 0)
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()

    // Restore scrollable geometry: the rail and its cluster target return,
    // but the STALE menu must not reappear - the hygiene effect cleared it
    // (and its opener element, now detached, with it).
    mockScroll(scroller, 0, 1000, CLIENT_HEIGHT)
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: 'Prompts 1-60 — open list' })).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  // Round-3 Finding 1 (bounded menu): a dense run can list dozens of
  // prompts; the menu must be a BOUNDED, scrollable surface so it can never
  // overflow the viewport. jsdom cannot compute overflow — these class pins
  // plus the e2e's scrollHeight > clientHeight assertion carry the real
  // bounding behavior. 120 prompts thins the slot to 5/3: the whole rail is
  // still ONE mega-run whose menu lists all 120.
  it('bounds the cluster menu at 60vh and lists every prompt of a 120-member dense run', () => {
    setupDenseClusterTranscript(120)
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-120 — open list' }))

    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(120)
    // Bounded surface: the instantiation passes max-h + overflow classes
    // through the primitive's new className prop (merged by its cn(...)).
    expect(menu).toHaveClass('max-h-[60vh]')
    expect(menu).toHaveClass('overflow-y-auto')
  })

  it('keeps the keyboard-focused menu item visible in the bounded list (scrollFocusedItemIntoView)', () => {
    setupDenseClusterTranscript(120)
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-120 — open list' }))
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    // jsdom 25 has NO Element.prototype.scrollIntoView (and vi.spyOn refuses
    // absent properties), so install the mock the suite's standard way:
    // per-element vi.fn() assignment (Global Constraints).
    const scrollIntoViewSpy = vi.fn()
    items.forEach((item) => { item.scrollIntoView = scrollIntoViewSpy })
    // Arrow to the last item: every step moves focus; with the flag on,
    // focusItem also scrolls the focused item into view inside the
    // bounded list (the primitive's default stays preventScroll — the
    // focusItem comment).
    for (let i = 0; i < items.length - 1; i++) {
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
    }
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(document.activeElement).toBe(items[items.length - 1])
  })

  // Round-3 Finding 2 (stale snapshot): the open menu's items/position were
  // captured at open; ANY re-measure must close it — a menu that outlives
  // its geometry shows stale prompts and a stale position. This is the
  // geometry-change path, NOT the rail-hidden one: the layout stays
  // non-null and the rail keeps rendering throughout.
  it('closes the open cluster menu when a re-measure replaces the transcript geometry', () => {
    const { scroller } = setupDenseClusterTranscript()
    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-60 — open list' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // A streamed prompt grows the transcript: same article rects, new
    // scrollHeight — a NEW measurement object while the layout stays
    // non-null.
    mockScroll(scroller, 0, 1200, CLIENT_HEIGHT)
    fireEvent.scroll(scroller)
    // Assert immediately after the change event (not just after restore):
    // the menu closed on the re-measure itself, while the rail and its
    // cluster target stayed mounted.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prompts 1-60 — open list' })).toBeInTheDocument()

    // Restoring the geometry does NOT resurrect the closed menu.
    mockScroll(scroller, 0, 1000, CLIENT_HEIGHT)
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
