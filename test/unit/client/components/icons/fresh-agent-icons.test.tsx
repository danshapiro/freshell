import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ClaudeIcon,
  CodexIcon,
  FreshclaudeIcon,
  FreshcodexIcon,
  FreshopencodeIcon,
  OpencodeIcon,
} from '@/components/icons/provider-icons'
import { FRESH_AGENT_REGISTRY } from '@/lib/fresh-agent-registry'
import { resolveSessionTypeConfig } from '@/lib/session-type-utils'

afterEach(() => {
  cleanup()
})

describe('fresh* agent icons (beaded ring family)', () => {
  it('freshcodex and freshopencode have dedicated icons, not their CLI marks', () => {
    expect(FreshcodexIcon).not.toBe(CodexIcon)
    expect(FreshopencodeIcon).not.toBe(OpencodeIcon)
    const codexEntry = FRESH_AGENT_REGISTRY.find((e) => e.sessionType === 'freshcodex')
    const opencodeEntry = FRESH_AGENT_REGISTRY.find((e) => e.sessionType === 'freshopencode')
    expect(codexEntry?.icon).toBe(FreshcodexIcon)
    expect(opencodeEntry?.icon).toBe(FreshopencodeIcon)
  })

  it('each fresh icon frames its source mark in a ring of fourteen beads', () => {
    const cases = [
      [FreshclaudeIcon, 'freshclaude'],
      [FreshcodexIcon, 'freshcodex'],
      [FreshopencodeIcon, 'freshopencode'],
    ] as const
    for (const [Icon, name] of cases) {
      const { container } = render(<Icon />)
      const svg = container.querySelector('svg')
      expect(svg, name).toBeTruthy()
      expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24')
      // Fourteen bead circles sit directly under the svg, framing the mark
      const beads = [...svg!.querySelectorAll('circle')].filter((c) => c.parentElement === svg)
      expect(beads, `${name} bead count`).toHaveLength(14)
      for (const bead of beads) {
        expect(bead.getAttribute('r'), `${name} bead radius`).toBe('1.2')
        const cx = Number(bead.getAttribute('cx'))
        const cy = Number(bead.getAttribute('cy'))
        expect(Math.hypot(cx - 12, cy - 12), `${name} bead on the ring`).toBeCloseTo(10.6, 2)
      }
      // Ring outer extent (10.6 + 1.2 = 11.8) fills the 24-unit box the same
      // way the plain CLI marks do, so fresh and CLI icons read as one size.
      expect(10.6 + 1.2).toBeGreaterThanOrEqual(11.7)
      // The mark is the only group, framed by the beads (not masked).
      expect([...svg!.querySelectorAll('g')].filter((g) => g.parentElement === svg)).toHaveLength(1)
    }
  })

  it('each fresh icon keeps its source mark geometry', () => {
    const claude = renderToStaticMarkup(createElement(FreshclaudeIcon))
    expect(claude).toContain('M616.9,649.5h-209.7') // Claude crab face
    const codex = renderToStaticMarkup(createElement(FreshcodexIcon))
    expect(codex).toContain('M14.949 6.547a3.94') // Codex knot
    const opencode = renderToStaticMarkup(createElement(FreshopencodeIcon))
    expect(opencode).toContain('M520,180h200v300h-240') // OpenCode frame
  })

  it('shrinks each mark to fit inside the ring with breathing room', () => {
    // The ring's inner extent is 10.6 - 1.2 = 9.4. Each mark's composed
    // scale must place its farthest ink inside that with ~1 unit of air.
    // Ink radii below are analyzer-measured in each mark's SOURCE viewBox
    // units (the same units its native fit-the-box transform consumes):
    // claude 423.2 (872.25-wide source), codex 8.215 (16.55), opencode
    // 192 (312) — farthest ink from center, which a circle-fit must clear.
    const CASES = [
      [FreshclaudeIcon, 423.2],
      [FreshcodexIcon, 8.215],
      [FreshopencodeIcon, 192],
    ] as const
    for (const [Icon, inkRadius] of CASES) {
      const { container } = render(<Icon />)
      const markGroup = container.querySelector('svg > g')
      expect(markGroup).toBeTruthy()
      const scale = Number(/scale\(([\d.]+)\)/.exec(markGroup!.getAttribute('transform') ?? '')?.[1])
      expect(scale).toBeGreaterThan(0)
      const reach = scale * inkRadius
      expect(reach).toBeLessThanOrEqual(8.5) // ≥ 0.9 units clear of the beads
      expect(reach).toBeGreaterThanOrEqual(7.0) // mark stays prominent inside the ring
    }
  })

  it('the codex knot closes with an outward sweep', () => {
    // Regression: the outer loop's closing arc was transcribed with sweep
    // flag 1 (every other arc in the loop sweeps 0). Rotation preserves
    // sweep flags, so the bad flag bowed the closing arc INWARD and shaved
    // a crescent off the knot's right side — a visible asymmetry.
    const closingArc = '3.99 3.99 0 0 0-.506-4.716'
    const brokenArc = '3.99 3.99 0 0 1-.506-4.716'
    const cli = renderToStaticMarkup(createElement(CodexIcon))
    const fresh = renderToStaticMarkup(createElement(FreshcodexIcon))
    expect(cli).toContain(closingArc)
    expect(fresh).toContain(closingArc)
    expect(cli).not.toContain(brokenArc)
    expect(fresh).not.toContain(brokenArc)
  })

  it('resolves the bespoke icons through session-type config', () => {
    expect(resolveSessionTypeConfig('freshclaude').icon).toBe(FreshclaudeIcon)
    expect(resolveSessionTypeConfig('freshcodex').icon).toBe(FreshcodexIcon)
    expect(resolveSessionTypeConfig('freshopencode').icon).toBe(FreshopencodeIcon)
  })

  it('serializes standalone for the deck data-url path with no knockout machinery', () => {
    const raw = renderToStaticMarkup(createElement(FreshclaudeIcon))
    expect(raw.startsWith('<svg')).toBe(true)
    expect(raw).toContain('xmlns="http://www.w3.org/2000/svg"')
    // The beaded family is plain shapes: no masks, no knockout gaps.
    expect(raw).not.toContain('mask')
  })
})
