import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  AmplifierIcon,
  DefaultProviderIcon,
  PROVIDER_ICONS,
  ProviderIcon,
} from '@/components/icons/provider-icons'

afterEach(() => {
  cleanup()
})

describe('PROVIDER_ICONS parity (picker "black circle" fix)', () => {
  it('registers a dedicated icon for every picker-visible CLI provider, including amplifier', () => {
    // Regression: `amplifier` was missing from this map entirely, so the
    // picker fell back to `DefaultProviderIcon` -- a plain filled circle,
    // reported as "a black circle" on the pick-a-coding-agent page. Guard
    // against a false-pass where BOTH sides are an unresolved `undefined`
    // import (which `toBe` would otherwise consider equal).
    expect(typeof AmplifierIcon).toBe('function')
    expect(PROVIDER_ICONS.amplifier).toBe(AmplifierIcon)
    // Parity check: every OTHER known CLI provider that already worked.
    expect(PROVIDER_ICONS.claude).toBeDefined()
    expect(PROVIDER_ICONS.codex).toBeDefined()
    expect(PROVIDER_ICONS.gemini).toBeDefined()
    expect(PROVIDER_ICONS.kimi).toBeDefined()
    expect(PROVIDER_ICONS.opencode).toBeDefined()
  })

  it('ProviderIcon renders the AmplifierIcon markup, not the generic fallback circle', () => {
    const { container } = render(<ProviderIcon provider="amplifier" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // `DefaultProviderIcon` is the ONLY icon that renders a bare <circle>;
    // every real provider icon (including amplifier's brand mark) is built
    // from <path> elements instead.
    expect(container.querySelector('circle')).toBeNull()
    expect(container.querySelectorAll('path').length).toBeGreaterThan(0)
  })

  it('an unknown provider still falls back to DefaultProviderIcon (the circle)', () => {
    const { container } = render(<ProviderIcon provider="totally-unknown-provider" />)
    expect(container.querySelector('circle')).not.toBeNull()
  })

  it('DefaultProviderIcon is unchanged (still the fallback circle)', () => {
    const { container } = render(<DefaultProviderIcon />)
    expect(container.querySelector('circle')).not.toBeNull()
  })
})
