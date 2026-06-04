import { describe, expect, it } from 'vitest'
import { resolveRevealAttachPlan } from '@/lib/terminal-attach-policy'

describe('terminal attach policy', () => {
  it('promotes viewport hydrate to delta reconnect from a trusted rendered high-water mark', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'hidden_reveal',
      hasTrustedSurface: true,
      renderedSeq: 41,
    })).toEqual({
      intent: 'transport_reconnect',
      clearViewportFirst: false,
      priority: 'foreground',
      sinceSeq: 41,
    })
  })

  it('keeps full viewport hydrate when the mounted surface is not trusted', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'hidden_reveal',
      hasTrustedSurface: false,
      renderedSeq: 41,
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
    })
  })

  it('keeps full viewport hydrate for explicit user pane refresh', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'explicit_refresh',
      hasTrustedSurface: true,
      renderedSeq: 41,
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
    })
  })

  it('preserves transport reconnect intent and uses rendered high-water as sinceSeq', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'transport_reconnect',
      pendingReason: 'transport_reconnect',
      hasTrustedSurface: true,
      renderedSeq: 41,
    })).toEqual({
      intent: 'transport_reconnect',
      clearViewportFirst: false,
      priority: 'foreground',
      sinceSeq: 41,
    })
  })
})
