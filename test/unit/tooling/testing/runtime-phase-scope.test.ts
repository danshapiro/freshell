import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { certificationScopeForPhase } from '../../../../scripts/testing/runtime-phase-scope.js'

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../test/runtime/gate-manifest.json'), 'utf8'))

describe('progressive runtime gates and final provider certification have distinct scope', () => {
  it.each(['phase-1', 'phase-2', 'phase-3', 'phase-4'] as const)('%s is not mislabeled as the final production gate', (phase) => {
    const scope = certificationScopeForPhase(manifest.certification_gates, phase, 'production')
    expect(scope).toMatchObject({ required: false, caseIds: [], artifactNames: [], gateId: phase })
  })

  it.each(['landing', 'production'] as const)('phase 5 retains every required provider in %s mode', (mode) => {
    const scope = certificationScopeForPhase(manifest.certification_gates, 'phase-5', mode)
    expect(scope.required).toBe(true)
    expect(scope.caseIds).toEqual(['PC-SCOPE', 'PC-SHELL', 'PC-CLAUDE', 'PC-OPENCODE', 'PC-CODEX', 'PC-AMPLIFIER'])
    expect(scope.artifactNames).toContain('deferred-providers.json')
    expect(scope.gateId).toBe(manifest.certification_gates.modes[mode].id)
  })

  it('fails closed if certification is moved beyond the final implementation phase', () => {
    const altered = structuredClone(manifest.certification_gates)
    altered.modes.production.cumulative_phase = 'phase-6'
    expect(() => certificationScopeForPhase(altered, 'phase-5', 'production')).toThrow(/phase/)
  })

  it('fails closed when provider case declarations are empty or duplicate', () => {
    for (const ids of [[], ['PC-SCOPE', 'PC-SCOPE']]) {
      const altered = structuredClone(manifest.certification_gates)
      altered.provider_certification_case_ids = ids
      expect(() => certificationScopeForPhase(altered, 'phase-5', 'production')).toThrow(/case/)
    }
  })

  it('requires certification metadata even for earlier-phase runs', () => {
    expect(() => certificationScopeForPhase(undefined, 'phase-1', 'production')).toThrow(/certification/)
  })
})
