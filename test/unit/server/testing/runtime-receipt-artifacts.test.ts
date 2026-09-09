import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  RUNTIME_RECEIPT_ARTIFACTS,
  defaultReceiptFileName,
  receiptArtifactName,
} from '../../../../scripts/testing/runtime-receipts.js'

const repoRoot = path.resolve(__dirname, '../../../..')

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
      'FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT',
      'FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT',
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
  })

  it('keeps the producer defaults byte-identical to the shared table', () => {
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_BROWSER_RECEIPT')).toBe('p2-g01-browser-continuity.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_OPENCODE_RECEIPT')).toBe('p2-g04-real-opencode-continuity.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT')).toBe('p3-g10-provider-resurrection.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT')).toBe('p4-g08-runtime-tabs-rehydrate.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT')).toBe('p5-g02-real-opencode-loss.json')
    expect(defaultReceiptFileName('FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT')).toBe('p5-g09-browser-chaos.json')
  })

  it('rejects a receipt it has no canonical name for', () => {
    expect(() => receiptArtifactName('FRESHELL_RUNTIME_UNKNOWN_RECEIPT', 'P9-G99')).toThrow(/unknown receipt/i)
  })

  it('leaves no gate copying a receipt under a bare case id', () => {
    // Regression guard for the drift this table exists to prevent: a gate that
    // writes `writeBrowserArtifact(caseId, receipt)` produces an artifact whose
    // name says nothing about what it proves.
    for (const file of fs.readdirSync(path.join(repoRoot, 'test/runtime/gates'))) {
      const source = fs.readFileSync(path.join(repoRoot, 'test/runtime/gates', file), 'utf8')
      expect(source, `${file} copies a receipt under a bare case id`).not.toMatch(/writeBrowserArtifact\(caseId,/)
    }
  })
})
