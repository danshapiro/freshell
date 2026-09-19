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

type Vec = { x: number; y: number }

/** Parse the star window of the ring path: valleys (Q endpoints) and controls. */
function parseStarWindow(d: string) {
  // Star subpath: first M after the disc subpath, then 14 quadratic segments.
  const starMatch = /Z\s*M([\d.]+) ([\d.]+)((?:Q[\d.]+ [\d.]+ [\d.]+ [\d.]+)+)Z/.exec(d)
  if (!starMatch) return null
  const valleys: Vec[] = [{ x: Number(starMatch[1]), y: Number(starMatch[2]) }]
  const controls: Vec[] = []
  const qs = starMatch[3].match(/Q([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)/g) ?? []
  for (const q of qs) {
    const n = q.slice(1).match(/[\d.]+/g)!.map(Number)
    controls.push({ x: n[0], y: n[1] })
    valleys.push({ x: n[2], y: n[3] })
  }
  return { valleys, controls }
}

describe('fresh* agent icons (14-lobe star ring family)', () => {
  it('freshcodex and freshopencode have dedicated icons, not their CLI marks', () => {
    expect(FreshcodexIcon).not.toBe(CodexIcon)
    expect(FreshopencodeIcon).not.toBe(OpencodeIcon)
    const codexEntry = FRESH_AGENT_REGISTRY.find((e) => e.sessionType === 'freshcodex')
    const opencodeEntry = FRESH_AGENT_REGISTRY.find((e) => e.sessionType === 'freshopencode')
    expect(codexEntry?.icon).toBe(FreshcodexIcon)
    expect(opencodeEntry?.icon).toBe(FreshopencodeIcon)
  })

  it('each fresh icon frames its source mark in the 14-lobe star ring', () => {
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
      // A single evenodd ring path sits directly under the svg: a solid
      // disc with a 14-lobe star-shaped window, framing the mark.
      const ringPaths = [...svg!.querySelectorAll('path')].filter((p) => p.parentElement === svg)
      expect(ringPaths, `${name} ring path count`).toHaveLength(1)
      const d = ringPaths[0].getAttribute('d') ?? ''
      expect(ringPaths[0].getAttribute('fill-rule'), `${name} evenodd window`).toBe('evenodd')
      // Outer disc subpath: radius 11.8 fills the 24-unit box the same way
      // the plain CLI marks do, so fresh and CLI icons read as one size.
      expect(d.startsWith('M12 0.2A11.8 11.8 0 1 1 11.99 0.2Z'), `${name} disc subpath`).toBe(true)
      expect(d.match(/M/g)?.length, `${name} subpath count`).toBe(2)
      expect(d.match(/A/g)?.length, `${name} arc count`).toBe(1)
      expect(d.match(/Q/g)?.length, `${name} lobe count`).toBe(14)
      const star = parseStarWindow(d)
      expect(star, `${name} star window`).toBeTruthy()
      // Fourteen valleys (closing valley repeats the first) and controls.
      expect(star!.valleys).toHaveLength(15)
      expect(star!.controls).toHaveLength(14)
      for (const v of star!.valleys) {
        expect(Math.hypot(v.x - 12, v.y - 12), `${name} valley radius`).toBeCloseTo(9.0, 2)
      }
      for (const c of star!.controls) {
        const r = Math.hypot(c.x - 12, c.y - 12)
        expect(r, `${name} control radius`).toBeGreaterThan(11.5)
        expect(r, `${name} control radius`).toBeLessThan(11.75)
      }
      // Each quadratic's apex (curve midpoint) is the lobe tip.
      for (let i = 0; i < 14; i++) {
        const p0 = star!.valleys[i]
        const c = star!.controls[i]
        const p1 = star!.valleys[i + 1]
        const apex = { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y }
        const r = Math.hypot(apex.x - 12, apex.y - 12)
        expect(r, `${name} lobe apex radius`).toBeGreaterThan(10.05)
        expect(r, `${name} lobe apex radius`).toBeLessThan(10.35)
      }
      // The mark is the only group, framed by the ring (not masked).
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

  it('shrinks each mark to fit inside the star window with breathing room', () => {
    // The ring window's inner extent is the valleys at radius 9.0. Each
    // mark's composed scale must place its farthest ink inside that with
    // ~1 unit of air (Option A proportions: reach 7.83–7.92).
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
      expect(reach).toBeLessThanOrEqual(8.0) // ≥ 1.0 units clear of the valleys
      expect(reach).toBeGreaterThanOrEqual(7.5) // mark stays prominent inside the ring
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
    // The star ring family is plain shapes: one evenodd path, no masks, no
    // knockout gaps, no bead circles.
    expect(raw).toContain('fill-rule="evenodd"')
    expect(raw).not.toContain('mask')
    expect(raw).not.toContain('<circle')
  })
})
