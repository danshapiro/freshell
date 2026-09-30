import { describe, expect, it } from 'vitest'

import {
  RUNTIME_RECEIPT_ARTIFACTS,
  defaultReceiptFileName,
  receiptArtifactName,
} from '../../../../scripts/testing/runtime-receipts.js'

/**
 * A gate evidence tree has to be reviewable on its own. `browser/p5-g09.json`
 * records that some receipt was accepted; it does not record *what* it proved.
 * Producer and consumer therefore share one naming table, so a receipt keeps
 * its self-describing name wherever it lands.
 */
describe('runtime receipt artifact naming', () => {
  it('covers exactly the receipts the cumulative gate consumes', () => {
    expect(Object.keys(RUNTIME_RECEIPT_ARTIFACTS).sort()).toEqual([
      'FRESHELL_RUNTIME_BROWSER_RECEIPT',
      'FRESHELL_RUNTIME_OPENCODE_RECEIPT',
      'FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT',
      'FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT',
      'FRESHELL_RUNTIME_PROVIDER_PARITY_LOCAL_RECEIPT',
    ])
  })

  it('names every copied artifact after its case and the kind of proof it carries', () => {
    expect(receiptArtifactName('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT', 'P4-G08'))
      .toBe('p4-g08-runtime-tabs-rehydrate')
    expect(receiptArtifactName('FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT', 'P5-G02'))
      .toBe('p5-g02-real-opencode-loss')
    expect(receiptArtifactName('FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT', 'P5-G09'))
      .toBe('p5-g09-browser-chaos')
    expect(receiptArtifactName('FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT', 'P5-G10'))
      .toBe('p5-g10-phase5-soak')
    expect(receiptArtifactName('FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT', 'P5-G01'))
      .toBe('p5-g01-provider-matrix')
    expect(receiptArtifactName('FRESHELL_RUNTIME_PROVIDER_PARITY_LOCAL_RECEIPT', 'PC-PARITY-CLAUDE'))
      .toBe('pc-parity-claude-provider-parity-local')
  })

  it('keeps the producer defaults byte-identical to the shared table', () => {
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_BROWSER_RECEIPT')).toBe('p2-g01-browser-continuity.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_OPENCODE_RECEIPT')).toBe('p2-g04-real-opencode-continuity.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT')).toBe('p3-g10-provider-resurrection.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT')).toBe('p4-g08-runtime-tabs-rehydrate.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT')).toBe('p5-g02-real-opencode-loss.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT')).toBe('p5-g09-browser-chaos.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PROVIDER_PARITY_LOCAL_RECEIPT'))
      .toBe('pc-parity-claude-provider-parity-local.json')
  })

  it('rejects a receipt it has no canonical name for', () => {
    expect(() => receiptArtifactName('FRESHELL_RUNTIME_UNKNOWN_RECEIPT', 'P9-G99')).toThrow(/unknown receipt/i)
  })

})
