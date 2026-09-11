import { describe, expect, it } from 'vitest'
import { parseGateArgs } from '../../../../scripts/testing/runtime-gate-args.js'
import { PHASE1_CASE_IDS } from '../../../runtime/gates/phase-1.test.js'
import { PHASE2_CASE_IDS } from '../../../runtime/gates/phase-2.test.js'
import { PHASE3_CASE_IDS } from '../../../runtime/gates/phase-3.test.js'
import { PHASE4_CASE_IDS } from '../../../runtime/gates/phase-4.test.js'
import { PHASE5_CASE_IDS } from '../../../runtime/gates/phase-5.test.js'

describe('direct deterministic runtime selection', () => {
  it('lists without permission to start workloads and requires opt-in to execute', () => {
    expect(parseGateArgs(['gate', 'phase-5', '--list'])).toEqual({ phase: 'phase-5', list: true })
    expect(parseGateArgs(['gate', 'phase-5'])).toMatchObject({ exitCode: 2 })
    expect(parseGateArgs(['gate', 'phase-5', '--require-live', '--case', 'P5-G06']))
      .toEqual({ phase: 'phase-5', only: 'P5-G06', list: false })
  })
  it('rejects retired approval modes and malformed selectors instead of guessing', () => {
    for (const args of [['gate', 'landing', '--require-live'], ['gate', 'phase-5', '--case'], ['gate', 'phase-5', '--require-live', '--unknown'], ['gate', 'phase-5', '--require-live', '--case', 'P5-G06', '--case', 'P5-G07']]) {
      expect(parseGateArgs(args)).toHaveProperty('error')
    }
  })
  it('retains all fifty unique deterministic cases after six report consumers move to direct tests', () => {
    const ids = [...PHASE1_CASE_IDS, ...PHASE2_CASE_IDS, ...PHASE3_CASE_IDS, ...PHASE4_CASE_IDS, ...PHASE5_CASE_IDS]
    expect(ids).toHaveLength(50)
    expect(new Set(ids).size).toBe(50)
    for (const id of ['P5-G06','P5-G07','P5-G08','P3-G09']) expect(ids).toContain(id)
    for (const id of ['P2-G01','P2-G04','P3-G01','P3-G10','P4-G08','P5-G10']) expect(ids).not.toContain(id)
  })
})
