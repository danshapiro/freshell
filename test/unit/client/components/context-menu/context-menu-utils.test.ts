import { afterEach, describe, it, expect } from 'vitest'
import { parseContextTarget, clampToViewport } from '@/components/context-menu/context-menu-utils'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

describe('parseContextTarget', () => {
  it('parseContextTarget for Terminal returns hoveredUrl from dataset', () => {
    const result = parseContextTarget(ContextIds.Terminal, {
      tabId: 'tab-1',
      paneId: 'pane-1',
      hoveredUrl: 'https://example.com',
    })
    expect(result).toEqual({
      kind: 'terminal',
      tabId: 'tab-1',
      paneId: 'pane-1',
      hoveredUrl: 'https://example.com',
    })
  })

  it('parseContextTarget for Terminal returns hoveredUrl as undefined when not in dataset', () => {
    const result = parseContextTarget(ContextIds.Terminal, {
      tabId: 'tab-1',
      paneId: 'pane-1',
    })
    expect(result).toEqual({
      kind: 'terminal',
      tabId: 'tab-1',
      paneId: 'pane-1',
      hoveredUrl: undefined,
    })
  })

  it('parseContextTarget for Terminal returns null when tabId is missing', () => {
    const result = parseContextTarget(ContextIds.Terminal, {
      paneId: 'pane-1',
    })
    expect(result).toBeNull()
  })

  it('parseContextTarget for Terminal returns null when paneId is missing', () => {
    const result = parseContextTarget(ContextIds.Terminal, {
      tabId: 'tab-1',
    })
    expect(result).toBeNull()
  })

  it('parseContextTarget for Global returns global target', () => {
    const result = parseContextTarget(ContextIds.Global, {})
    expect(result).toEqual({ kind: 'global' })
  })

  it('parseContextTarget for Tab returns tab target with tabId', () => {
    const result = parseContextTarget(ContextIds.Tab, { tabId: 'tab-1' })
    expect(result).toEqual({ kind: 'tab', tabId: 'tab-1' })
  })

  it('parseContextTarget for FreshAgent preserves pane and session flavor identity', () => {
    const result = parseContextTarget(ContextIds.FreshAgent, {
      tabId: 'tab-1',
      paneId: 'pane-1',
      sessionId: 'thread-1',
      provider: 'claude',
      sessionType: 'freshclaude',
    })

    expect(result).toEqual({
      kind: 'fresh-agent',
      tabId: 'tab-1',
      paneId: 'pane-1',
      sessionId: 'thread-1',
      provider: 'claude',
      sessionType: 'freshclaude',
    })
  })

  it('parseContextTarget for FreshAgent accepts pane identity without a DOM session id', () => {
    const result = parseContextTarget(ContextIds.FreshAgent, {
      tabId: 'tab-1',
      paneId: 'pane-1',
      provider: 'codex',
      sessionType: 'freshcodex',
    })

    expect(result).toEqual({
      kind: 'fresh-agent',
      tabId: 'tab-1',
      paneId: 'pane-1',
      sessionId: undefined,
      provider: 'codex',
      sessionType: 'freshcodex',
    })
  })

  it('parseContextTarget for FreshAgent returns null without session or pane identity', () => {
    const result = parseContextTarget(ContextIds.FreshAgent, {
      provider: 'codex',
      sessionType: 'freshcodex',
    })

    expect(result).toBeNull()
  })

  it('parseContextTarget for TabsCard returns tabs-card target with tabKey and status', () => {
    const result = parseContextTarget(ContextIds.TabsCard, { tabKey: 'device-a:tab-1', tabStatus: 'closed' })
    expect(result).toEqual({ kind: 'tabs-card', tabKey: 'device-a:tab-1', status: 'closed' })
  })

  it('parseContextTarget for TabsCard defaults status to open', () => {
    const result = parseContextTarget(ContextIds.TabsCard, { tabKey: 'device-a:tab-1' })
    expect(result).toEqual({ kind: 'tabs-card', tabKey: 'device-a:tab-1', status: 'open' })
  })

  it('parseContextTarget for TabsCard returns null without tabKey', () => {
    const result = parseContextTarget(ContextIds.TabsCard, { tabStatus: 'closed' })
    expect(result).toBeNull()
  })
})

describe('clampToViewport with visualViewport (mobile keyboard awareness)', () => {
  const originalVisualViewport = window.visualViewport

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      configurable: true,
    })
  })

  function installVisualViewport(rect: {
    width: number
    height: number
    offsetLeft?: number
    offsetTop?: number
  }) {
    Object.defineProperty(window, 'visualViewport', {
      value: {
        width: rect.width,
        height: rect.height,
        offsetLeft: rect.offsetLeft ?? 0,
        offsetTop: rect.offsetTop ?? 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
    })
  }

  it('clamps to the visual viewport when the keyboard shrinks it below window.innerHeight', () => {
    // jsdom layout viewport is 1024x768; simulate a keyboard leaving 400px visible.
    installVisualViewport({ width: 1024, height: 400 })
    const result = clampToViewport(100, 700, 200, 150, 8)
    // maxY = 0 + 400 - 150 - 8 = 242 -- NOT the layout-viewport 768-150-8=610.
    expect(result).toEqual({ x: 100, y: 242 })
  })

  it('respects visualViewport offsets (pinch-zoom / scrolled visual viewport)', () => {
    installVisualViewport({ width: 500, height: 400, offsetLeft: 50, offsetTop: 100 })
    const result = clampToViewport(0, 0, 200, 150, 8)
    // minX = 50 + 8 = 58, minY = 100 + 8 = 108.
    expect(result).toEqual({ x: 58, y: 108 })
  })

  it('falls back to the layout viewport when visualViewport is unavailable', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    // jsdom: innerWidth=1024, innerHeight=768.
    // maxX = 1024-200-8 = 816; maxY = 768-150-8 = 610 -- identical to the old math.
    const result = clampToViewport(2000, 2000, 200, 150, 8)
    expect(result).toEqual({ x: 816, y: 610 })
  })
})
