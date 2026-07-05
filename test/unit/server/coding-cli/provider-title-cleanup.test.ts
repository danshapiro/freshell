import { describe, it, expect } from 'vitest'
import { overrideKeysToClear } from '../../../../server/coding-cli/provider-title-cleanup'
import type { SessionOverride } from '../../../../server/config-store'

describe('overrideKeysToClear', () => {
  const authoritative = new Set(['amplifier'])

  it('returns ai/first-message/dir/legacy overrides on authoritative-provider keys', () => {
    const overrides: Record<string, SessionOverride> = {
      'amplifier:ai': { titleOverride: 'X', titleSource: 'ai' },
      'amplifier:first': { titleOverride: 'X', titleSource: 'first-message' },
      'amplifier:dir': { titleOverride: 'X', titleSource: 'dir' },
      'amplifier:legacy': { titleOverride: 'X', titleSource: 'legacy' },
    }

    expect(overrideKeysToClear(overrides, authoritative).sort()).toEqual([
      'amplifier:ai',
      'amplifier:dir',
      'amplifier:first',
      'amplifier:legacy',
    ])
  })

  it('preserves explicit user overrides', () => {
    const overrides: Record<string, SessionOverride> = {
      'amplifier:user': { titleOverride: 'My Rename', titleSource: 'user' },
    }

    expect(overrideKeysToClear(overrides, authoritative)).toEqual([])
  })

  it('ignores keys whose provider is not authoritative', () => {
    const overrides: Record<string, SessionOverride> = {
      'claude:ai': { titleOverride: 'X', titleSource: 'ai' },
      'codex:dir': { titleOverride: 'X', titleSource: 'dir' },
    }

    expect(overrideKeysToClear(overrides, authoritative)).toEqual([])
  })

  it('ignores authoritative-provider overrides that have no title override', () => {
    const overrides: Record<string, SessionOverride> = {
      'amplifier:archived-only': { archived: true },
      'amplifier:summary-only': { summaryOverride: 'S' },
    }

    expect(overrideKeysToClear(overrides, authoritative)).toEqual([])
  })
})
