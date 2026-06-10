import { describe, expect, it } from 'vitest'
import { resolveRevealAttachPlan } from '@/lib/terminal-attach-policy'

describe('terminal attach policy', () => {
  it('promotes viewport hydrate to delta reconnect from a compatible checkpoint', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'hidden_reveal',
      checkpointDecision: { ok: true, sinceSeq: 41 },
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
      checkpointDecision: { ok: false, reason: 'missing_checkpoint' },
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
      trustResultingSurfaceForDeltaReplay: false,
    })
  })

  it('keeps full viewport hydrate for explicit user pane refresh', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'explicit_refresh',
      checkpointDecision: { ok: true, sinceSeq: 41 },
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
      trustResultingSurfaceForDeltaReplay: false,
    })
  })

  it('preserves transport reconnect intent and uses rendered high-water as sinceSeq', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'transport_reconnect',
      pendingReason: 'transport_reconnect',
      checkpointDecision: { ok: true, sinceSeq: 41 },
    })).toEqual({
      intent: 'transport_reconnect',
      clearViewportFirst: false,
      priority: 'foreground',
      sinceSeq: 41,
    })
  })

  it('falls back to clearing viewport hydrate for unsafe transport reconnect', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'transport_reconnect',
      pendingReason: 'hidden_reveal',
      checkpointDecision: { ok: false, reason: 'parser_busy' },
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
      trustResultingSurfaceForDeltaReplay: false,
    })
  })

  it('falls back to clearing viewport hydrate for unsafe keepalive delta', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'keepalive_delta',
      pendingReason: 'background_catchup',
      checkpointDecision: { ok: false, reason: 'geometry_changed' },
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
      trustResultingSurfaceForDeltaReplay: false,
    })
  })

  it('does not trust legacy rendered high-water input during checkpoint migration', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'hidden_reveal',
      hasTrustedSurface: true,
      renderedSeq: 41,
    })).toEqual({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
      trustResultingSurfaceForDeltaReplay: false,
    })
  })

  it('falls back to viewport hydrate when the parser-applied checkpoint is unsafe', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'hidden_reveal',
      checkpointDecision: { ok: false, reason: 'geometry_changed' },
    })).toMatchObject({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
    })
  })

  it('does not treat replay from zero as trusted full hydrate without compatible geometry history', () => {
    expect(resolveRevealAttachPlan({
      pendingIntent: 'viewport_hydrate',
      pendingReason: 'hidden_reveal',
      checkpointDecision: { ok: false, reason: 'geometry_changed' },
      replayHydrateCoversCompatibleGeometryHistory: false,
    })).toMatchObject({
      intent: 'viewport_hydrate',
      clearViewportFirst: true,
      priority: 'foreground',
      trustResultingSurfaceForDeltaReplay: false,
    })
  })
})
