import { describe, expect, it } from 'vitest'

import {
  QUALIFICATION_PROVIDER_SELECTION_ENV,
  parseQualificationProviderSelection,
} from '../../../../scripts/testing/provider-qualification-selection.js'
import { selectedProviderFromArgs } from '../../../../scripts/testing/runtime-provider-qualification.js'

describe('managed terminal provider qualification selection', () => {
  it('selects one provider without requiring unrelated provider setup', () => {
    expect(parseQualificationProviderSelection('claude')).toEqual(['claude'])
    expect(parseQualificationProviderSelection('codex')).toEqual(['codex'])
    expect(parseQualificationProviderSelection('amplifier')).toEqual(['amplifier'])
  })

  it('preserves the declared order for an explicit bounded subset', () => {
    expect(parseQualificationProviderSelection('codex,claude')).toEqual(['codex', 'claude'])
  })

  it.each(['', 'all', 'claude,claude', 'freshclaude', 'claude, amplifier', 'unknown'])(
    'rejects malformed or broadened selection %j',
    (value) => {
      expect(() => parseQualificationProviderSelection(value)).toThrow(QUALIFICATION_PROVIDER_SELECTION_ENV)
    },
  )
})

describe('per-provider qualification producer', () => {
  it('selects exactly one provider without starting a live campaign', () => {
    expect(selectedProviderFromArgs(['--provider', 'claude'])).toBe('claude')
    expect(selectedProviderFromArgs(['codex'])).toBe('codex')
  })

  it('rejects combined or missing producer selections', () => {
    expect(() => selectedProviderFromArgs([])).toThrow(/usage/i)
    expect(() => selectedProviderFromArgs(['claude,codex'])).toThrow(/exactly one/i)
    expect(() => selectedProviderFromArgs(['--provider', 'all'])).toThrow(/unsupported/i)
  })
})
