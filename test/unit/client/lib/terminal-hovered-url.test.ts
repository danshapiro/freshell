import { describe, it, expect, afterEach } from 'vitest'
import { setHoveredUrl, getHoveredUrl, clearHoveredUrl } from '@/lib/terminal-hovered-url'

describe('terminal-hovered-url', () => {
  afterEach(() => {
    // Clean up any state left by tests
    clearHoveredUrl('pane-1')
    clearHoveredUrl('pane-2')
    clearHoveredUrl('pane-x')
    clearHoveredUrl('nonexistent')
  })

  it('getHoveredUrl returns undefined for unknown paneId', () => {
    expect(getHoveredUrl('pane-x')).toBeUndefined()
  })

  it('setHoveredUrl stores a URL for a pane', () => {
    setHoveredUrl('pane-1', 'https://a.com')
    expect(getHoveredUrl('pane-1')).toBe('https://a.com')
  })

  it('setHoveredUrl overwrites a previous URL for the same pane', () => {
    setHoveredUrl('pane-1', 'https://first.com')
    setHoveredUrl('pane-1', 'https://second.com')
    expect(getHoveredUrl('pane-1')).toBe('https://second.com')
  })

  it('clearHoveredUrl removes the stored URL', () => {
    setHoveredUrl('pane-1', 'https://a.com')
    clearHoveredUrl('pane-1')
    expect(getHoveredUrl('pane-1')).toBeUndefined()
  })

  it('clearHoveredUrl on unknown paneId is a no-op', () => {
    expect(() => clearHoveredUrl('nonexistent')).not.toThrow()
  })

  it('multiple panes are tracked independently', () => {
    setHoveredUrl('pane-1', 'https://one.com')
    setHoveredUrl('pane-2', 'https://two.com')
    expect(getHoveredUrl('pane-1')).toBe('https://one.com')
    expect(getHoveredUrl('pane-2')).toBe('https://two.com')

    clearHoveredUrl('pane-1')
    expect(getHoveredUrl('pane-1')).toBeUndefined()
    expect(getHoveredUrl('pane-2')).toBe('https://two.com')
  })
})
