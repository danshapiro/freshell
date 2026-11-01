import { describe, expect, it } from 'vitest'
import { isFreshAgentRevealRevisionFresh } from '@/lib/fresh-agent-reveal-freshness'

const reconnectAtRevisionFive = {
  provider: 'opencode',
  baseRevision: 5,
  requiresRevisionAdvance: false,
  snapshotRevision: 5,
  projectionNeedsResnapshot: false,
  projectionRevisionIsFresh: false,
}

describe('fresh-agent reveal snapshot freshness', () => {
  it('accepts an unchanged OpenCode revision when reconnect is the only invalidation cause', () => {
    expect(isFreshAgentRevealRevisionFresh(reconnectAtRevisionFive)).toBe(true)
  })

  it('keeps an unchanged revision blocked after transcript or send invalidation', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, requiresRevisionAdvance: true })).toBe(false)
  })

  it('keeps a lower revision blocked after reconnect', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: 4 })).toBe(false)
  })

  it('does not accept an unchanged revision for another provider', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, provider: 'codex' })).toBe(false)
  })

  it('requires current projection coverage while a live projection needs resnapshot', () => {
    expect(isFreshAgentRevealRevisionFresh({
      ...reconnectAtRevisionFive,
      projectionNeedsResnapshot: true,
    })).toBe(false)
    expect(isFreshAgentRevealRevisionFresh({
      ...reconnectAtRevisionFive,
      projectionNeedsResnapshot: true,
      projectionRevisionIsFresh: true,
    })).toBe(true)
  })

  it('accepts a newer or unavailable revision when no projection resnapshot is pending', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: 6, requiresRevisionAdvance: true })).toBe(true)
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: undefined, requiresRevisionAdvance: true })).toBe(true)
  })
})
