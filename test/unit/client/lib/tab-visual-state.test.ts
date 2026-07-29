import { describe, it, expect } from 'vitest'
import { resolveTabVisualState, tabHasLivePane } from '@/lib/tab-visual-state'
import type { PaneContent } from '@/store/paneTypes'

const base = {
  isBusy: false,
  hasAttention: false,
  isReady: false,
  isActive: false,
  hasLivePane: true,
}

describe('resolveTabVisualState', () => {
  it('returns neutral for a plain tab (no busy, no attention, no ready)', () => {
    expect(resolveTabVisualState({ ...base })).toBe('neutral')
  })

  it('returns working (GREY) when any pane is busy', () => {
    expect(resolveTabVisualState({ ...base, isBusy: true })).toBe('working')
  })

  it('working takes precedence over ready and attention (new turn started)', () => {
    expect(resolveTabVisualState({ ...base, isBusy: true, isReady: true, hasAttention: true }))
      .toBe('working')
  })

  it('returns ready-unacked (GREEN + BAR) when attention is set and tab is not active', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: true })).toBe('ready-unacked')
  })

  it('never shows the bar on the active tab: attention + active -> ready (plain GREEN)', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: true, isActive: true })).toBe('ready')
  })

  it('returns ready (plain GREEN) after acknowledgement: ready flag persists, attention cleared', () => {
    expect(resolveTabVisualState({ ...base, isReady: true })).toBe('ready')
  })

  it('waiting-for-approval maps to ready-unacked (attention set via #waiting, busy suppressed upstream)', () => {
    // Upstream machinery guarantees isBusy=false while pending permissions/questions exist
    // and marks attention via the `${sessionKey}#waiting` dedupe namespace.
    expect(resolveTabVisualState({ ...base, isBusy: false, hasAttention: true, isReady: true }))
      .toBe('ready-unacked')
  })

  it('a dead tab is neutral regardless of stale flags', () => {
    expect(resolveTabVisualState({
      ...base, hasLivePane: false, isBusy: true, hasAttention: true, isReady: true,
    })).toBe('neutral')
  })
})

describe('tabHasLivePane', () => {
  const terminal = (status: 'creating' | 'running' | 'recovering' | 'exited' | 'error'): PaneContent =>
    ({ kind: 'terminal', createRequestId: 'r', status, mode: 'shell' }) as PaneContent

  it('true when any terminal pane is not exited/error', () => {
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

  it('fresh-agent panes count as live (session-managed lifecycle)', () => {
    const freshAgent = { kind: 'fresh-agent' } as PaneContent
    expect(tabHasLivePane({ status: 'exited' }, [{ content: freshAgent }])).toBe(true)
  })

  it('falls back to tab.status when there are no pane entries', () => {
    expect(tabHasLivePane({ status: 'running' })).toBe(true)
    expect(tabHasLivePane({ status: 'exited' }, [])).toBe(false)
    expect(tabHasLivePane({ status: 'error' })).toBe(false)
  })
})
