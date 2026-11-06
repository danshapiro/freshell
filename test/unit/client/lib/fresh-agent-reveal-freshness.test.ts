import { describe, expect, it } from 'vitest'
import { isFreshAgentRevealRevisionFresh } from '@/lib/fresh-agent-reveal-freshness'

const reconnectAtRevisionFive = {
  provider: 'opencode',
  baseRevision: 5,
  requiresRevisionAdvance: false,
  snapshotRevision: 5,
  verifiedCurrent: true,
  projectionNeedsResnapshot: false,
  projectionRevisionIsFresh: false,
}

describe('fresh-agent reveal snapshot freshness', () => {
  it('accepts unchanged authoritative content for each provider when reconnect is the only invalidation cause', () => {
    for (const provider of ['codex', 'claude', 'opencode']) {
      expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, provider })).toBe(true)
    }
  })

  it('keeps an unchanged revision blocked after transcript or send invalidation', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, requiresRevisionAdvance: true })).toBe(false)
  })

  it('keeps a lower revision blocked after reconnect', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: 4 })).toBe(false)
  })

  it('does not accept revision equality without a current authoritative read', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, provider: 'codex', verifiedCurrent: false })).toBe(false)
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, provider: 'claude', verifiedCurrent: false })).toBe(false)
  })

  it('does not let an unchanged authoritative revision clear a transcript-change requirement', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, requiresRevisionAdvance: true })).toBe(false)
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: 6, requiresRevisionAdvance: true })).toBe(true)
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

  it('accepts a newer revision after transcript invalidation and an unversioned authoritative reconnect read', () => {
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: 6, requiresRevisionAdvance: true })).toBe(true)
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: undefined })).toBe(true)
    expect(isFreshAgentRevealRevisionFresh({ ...reconnectAtRevisionFive, snapshotRevision: undefined, verifiedCurrent: false })).toBe(false)
  })
})
