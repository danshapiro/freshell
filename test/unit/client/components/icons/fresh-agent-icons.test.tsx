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

describe('fresh* agent icons (seedling badge family)', () => {
  it('freshcodex and freshopencode have dedicated icons, not their CLI marks', () => {
    expect(FreshcodexIcon).not.toBe(CodexIcon)
    expect(FreshopencodeIcon).not.toBe(OpencodeIcon)
    const codexEntry = FRESH_AGENT_REGISTRY.find((e) => e.sessionType === 'freshcodex')
    const opencodeEntry = FRESH_AGENT_REGISTRY.find((e) => e.sessionType === 'freshopencode')
    expect(codexEntry?.icon).toBe(FreshcodexIcon)
    expect(opencodeEntry?.icon).toBe(FreshopencodeIcon)
  })

  it('each fresh icon renders its source mark plus a full-strength seedling', () => {
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
      // The seedling layer: full-strength ink (no fill-opacity dimming — the
      // 50% grey variant was too faint in dark mode), with the soil mound.
      const mound = container.querySelector('g[transform] > ellipse')
      expect(mound, `${name} soil mound`).toBeTruthy()
      const sprout = mound!.closest('g')
      expect(sprout!.getAttribute('fill-opacity')).toBeNull()
      // A knockout mask separates the seedling from the mark above its root line
      expect(container.querySelector('mask'), `${name} knockout mask`).toBeTruthy()
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

  it('renders the mark at the same size as its plain CLI icon', () => {
    // The mark group inside the mask fills the 24-unit box exactly like the
    // plain icon's native viewBox does — the badge must not shrink the mark.
    const cases = [
      [FreshclaudeIcon, 872.25],
      [FreshcodexIcon, 16.55],
      [FreshopencodeIcon, 312],
    ] as const
    for (const [Icon, sourceWidth] of cases) {
      const { container } = render(<Icon />)
      const markGroup = container.querySelector('g[mask] > g')
      expect(markGroup).toBeTruthy()
      const scale = Number(/scale\(([\d.]+)\)/.exec(markGroup!.getAttribute('transform') ?? '')?.[1])
      expect(scale).toBeGreaterThan(0)
      expect(scale * sourceWidth).toBeCloseTo(24, 2)
    }
  })

  it('anchors the seedling in the lower-right corner of the icon', () => {
    const cases = [
      [FreshclaudeIcon, 'freshclaude'],
      [FreshcodexIcon, 'freshcodex'],
      [FreshopencodeIcon, 'freshopencode'],
    ] as const
    for (const [Icon, name] of cases) {
      const { container } = render(<Icon />)
      const mound = container.querySelector('g[transform] > ellipse')!
      const g = mound.closest('g')!
      const transform = g.getAttribute('transform') ?? ''
      const scale = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1])
      const tx = Number(/translate\((-?[\d.]+) /.exec(transform)?.[1])
      const ty = Number(/translate\(-?[\d.]+ (-?[\d.]+)\)/.exec(transform)?.[1])
      const moundBottom = ty + (Number(mound.getAttribute('cy')) + Number(mound.getAttribute('ry'))) * scale
      const sproutRight = tx + 14.6 * scale // rightmost leaf extent in seedling-local units
      expect(moundBottom, `${name} mound bottom at the icon corner`).toBeCloseTo(23.7, 1)
      expect(sproutRight, `${name} seedling reaching the right edge`).toBeGreaterThanOrEqual(23.5)
    }
  })

  it('renders the shared seedling in front of the mark (mask applies to the mark only)', () => {
    const { container } = render(<FreshclaudeIcon />)
    const masked = container.querySelector('g[mask]')
    expect(masked).toBeTruthy()
    // The masked group is the mark layer; the seedling group is NOT masked
    const sprout = container.querySelector('g[transform] > ellipse')!.closest('g')!
    expect(masked!.contains(sprout)).toBe(false)
    expect(sprout.getAttribute('mask')).toBeNull()
  })

  it('roots the seedling below its root line (the knockout spares the mark there)', () => {
    // The mask ends with a white band: below y=16.05 the mark stays visible,
    // so the seedling's lower stem and mound union with the mark instead of
    // cutting floating fragments out of legs, bands, or lattice ends.
    const { container } = render(<FreshclaudeIcon />)
    const mask = container.querySelector('mask')!
    const band = mask.querySelector('rect[y="16.05"]')
    expect(band).toBeTruthy()
    expect(band!.getAttribute('fill')).toBe('white')
  })

  it('uses unique mask ids across simultaneous instances', () => {
    const { container } = render(
      <>
        <FreshclaudeIcon />
        <FreshclaudeIcon />
        <FreshcodexIcon />
      </>,
    )
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves the bespoke icons through session-type config', () => {
    expect(resolveSessionTypeConfig('freshclaude').icon).toBe(FreshclaudeIcon)
    expect(resolveSessionTypeConfig('freshcodex').icon).toBe(FreshcodexIcon)
    expect(resolveSessionTypeConfig('freshopencode').icon).toBe(FreshopencodeIcon)
  })

  it('still serializes standalone for the deck data-url path (mask refs stay internal)', () => {
    const raw = renderToStaticMarkup(createElement(FreshclaudeIcon))
    expect(raw.startsWith('<svg')).toBe(true)
    expect(raw).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(raw).toContain('mask="url(#')
  })
})
