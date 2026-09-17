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

  it('each fresh icon renders its source mark plus a half-strength seedling', () => {
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
      // The seedling layer: the icon set's grey (half-strength) with the soil mound
      const sprout = container.querySelector('g[fill-opacity="0.5"]')
      expect(sprout, `${name} seedling layer`).toBeTruthy()
      expect(sprout!.querySelector('ellipse'), `${name} soil mound`).toBeTruthy()
      // A knockout mask separates the seedling from the full-strength mark
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

  it('renders the shared seedling in front of the mark (mask applies to the mark only)', () => {
    const { container } = render(<FreshclaudeIcon />)
    const masked = container.querySelector('g[mask]')
    expect(masked).toBeTruthy()
    // The masked group is the mark layer; the seedling group is NOT masked
    expect(masked!.querySelector('g[fill-opacity="0.5"]')).toBeNull()
    expect(container.querySelector('g[fill-opacity="0.5"]')!.getAttribute('mask')).toBeNull()
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
