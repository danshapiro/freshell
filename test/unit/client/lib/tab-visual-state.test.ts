import { describe, it, expect } from 'vitest'
import { resolveTabVisualState, tabHasLivePane } from '@/lib/tab-visual-state'
import type { PaneContent } from '@/store/paneTypes'

const base = {
  isBusy: false,
  hasAttention: false,
  isActive: false,
  hasLivePane: true,
}

describe('resolveTabVisualState', () => {
  it('GREEN is the resting state: a live, non-busy tab is ready', () => {
    expect(resolveTabVisualState({ ...base })).toBe('ready')
  })

  it('returns working when any pane is busy (plain/neutral look)', () => {
    expect(resolveTabVisualState({ ...base, isBusy: true })).toBe('working')
  })

  it('working takes precedence over attention (new turn started)', () => {
    expect(resolveTabVisualState({ ...base, isBusy: true, hasAttention: true }))
      .toBe('working')
  })

  it('returns ready-unacked (GREEN + BAR) when attention is set and tab is not active', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: true })).toBe('ready-unacked')
  })

  it('never shows the bar on the active tab: attention + active -> ready (plain GREEN)', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: true, isActive: true })).toBe('ready')
  })

  it('acknowledgement (attention cleared) keeps the tab green: ready is the resting state', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: false })).toBe('ready')
  })

  it('waiting-for-approval maps to ready-unacked (attention set via #waiting, busy suppressed upstream)', () => {
    // Upstream machinery guarantees isBusy=false while pending permissions/questions exist
    // and marks attention via the `${sessionKey}#waiting` dedupe namespace.
    expect(resolveTabVisualState({ ...base, isBusy: false, hasAttention: true }))
      .toBe('ready-unacked')
  })

  it('a dead tab is neutral regardless of stale flags', () => {
    expect(resolveTabVisualState({
      ...base, hasLivePane: false, isBusy: true, hasAttention: true,
    })).toBe('neutral')
  })
})

describe('tabHasLivePane', () => {
  const terminal = (status: 'creating' | 'running' | 'recovering' | 'exited' | 'error'): PaneContent =>
    ({ kind: 'terminal', createRequestId: 'r', status, mode: 'shell' }) as PaneContent

  it('true when any terminal pane is running', () => {
    expect(tabHasLivePane({ status: 'running' }, [
      { content: terminal('exited') },
      { content: terminal('running') },
    ])).toBe(true)
  })

  it('false when ALL terminal panes are exited/error', () => {
    expect(tabHasLivePane({ status: 'running' }, [
      { content: terminal('exited') },
      { content: terminal('error') },
    ])).toBe(false)
  })

  it('a creating terminal is not yet ready for input (not live)', () => {
    expect(tabHasLivePane({ status: 'running' }, [
      { content: terminal('creating') },
    ])).toBe(false)
  })

  it('a recovering terminal counts as live (transiently reattaching, was running)', () => {
    expect(tabHasLivePane({ status: 'running' }, [
      { content: terminal('recovering') },
    ])).toBe(true)
  })

  it('a picker-only tab is not live (nothing to be ready for)', () => {
    const picker = { kind: 'picker' } as PaneContent
    expect(tabHasLivePane({ status: 'running' }, [{ content: picker }])).toBe(false)
  })

  it('fresh-agent panes count as live (session-managed lifecycle)', () => {
    const freshAgent = { kind: 'fresh-agent' } as PaneContent
    expect(tabHasLivePane({ status: 'exited' }, [{ content: freshAgent }])).toBe(true)
  })

  it('browser panes count as live', () => {
    const browser = { kind: 'browser' } as PaneContent
    expect(tabHasLivePane({ status: 'exited' }, [{ content: browser }])).toBe(true)
  })

  it('falls back to tab.status when there are no pane entries', () => {
    expect(tabHasLivePane({ status: 'running' })).toBe(true)
    expect(tabHasLivePane({ status: 'exited' }, [])).toBe(false)
    expect(tabHasLivePane({ status: 'error' })).toBe(false)
    // A still-creating tab is not ready for input yet.
    expect(tabHasLivePane({ status: 'creating' })).toBe(false)
  })
})
