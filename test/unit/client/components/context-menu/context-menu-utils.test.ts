import { describe, it, expect } from 'vitest'
import { parseContextTarget } from '@/components/context-menu/context-menu-utils'
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
})
