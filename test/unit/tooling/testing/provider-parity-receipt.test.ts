import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PROVIDER_PARITY_CASE_IDS,
  loadProviderParityLocalReceipt,
  validateProviderParityReceipt,
  type ProviderParityRow,
} from '../../../../scripts/testing/provider-parity-receipt.js'
import { validateProviderQualificationReceipt } from '../../../../scripts/testing/provider-qualification-receipt.js'
import { validateFreshAgentQualificationReceipt } from '../../../../scripts/testing/fresh-agent-qualification-receipt.js'

const trace = {
  argv: ['provider', '--model', 'fixture-model'],
  env: { FRESHELL: '1' },
  config: { setting: true },
  plugins: ['fixture-plugin'],
  mcp: { exposed: true, tools: ['freshell'], call: { ok: true } },
  operations: ['create', 'send', 'capture', 'resume'],
  nativeSessionId: 'native-session-1',
}

function rows(): ProviderParityRow[] {
  return PROVIDER_PARITY_CASE_IDS.map(caseId => ({
    caseId,
    direct: structuredClone(trace),
    managed: structuredClone(trace),
    secretHygiene: { registry: true, supervisor: true, eventJournal: true, docker: true },
    onecli: { approvedReference: true, unapprovedReferenceRejected: true,
      referenceProfile: `${caseId.replace(/^PC-PARITY-|^FA-PARITY-FRESH/, '').toLowerCase()}_onecli_environment`,
      childEnvironmentKey: 'OPENAI_API_KEY', childValueSha256: 'a'.repeat(64) },
    recovery: { replacementObserved: true, sameNativeSession: true },
  }))
}

describe('provider parity local receipt', () => {
  it('requires every named case and compares provider-visible behavior', () => {
    const receipt = { schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: rows() }
    expect(validateProviderParityReceipt(receipt).rows).toHaveLength(7)
    expect(() => validateProviderParityReceipt({ ...receipt, rows: receipt.rows.slice(1) })).toThrow(/missing.*PC-PARITY-CLAUDE/i)
    const lostPlugin = rows()
    lostPlugin[0].managed.plugins = []
    expect(() => validateProviderParityReceipt({ ...receipt, rows: lostPlugin })).toThrow(/PC-PARITY-CLAUDE.*plugins/i)
    const lostOperation = rows()
    lostOperation[4].managed.operations = ['create', 'send', 'resume']
    expect(() => validateProviderParityReceipt({ ...receipt, rows: lostOperation })).toThrow(/FA-PARITY-FRESHCLAUDE.*operations/i)
    const lostFreshInput = rows()
    lostFreshInput[4].managed.argv.splice(1, 1)
    expect(() => validateProviderParityReceipt({ ...receipt, rows: lostFreshInput })).toThrow(/FA-PARITY-FRESHCLAUDE.*argv/i)
    const lostFreshEnvironment = rows()
    delete lostFreshEnvironment[5].managed.env.FRESHELL
    expect(() => validateProviderParityReceipt({ ...receipt, rows: lostFreshEnvironment })).toThrow(/FA-PARITY-FRESHCODEX.*env/i)
    const emptyFreshBoundary = rows()
    emptyFreshBoundary[6].direct.argv = []
    emptyFreshBoundary[6].managed.argv = []
    emptyFreshBoundary[6].direct.env = {}
    emptyFreshBoundary[6].managed.env = {}
    expect(() => validateProviderParityReceipt({ ...receipt, rows: emptyFreshBoundary })).toThrow(/FA-PARITY-FRESHOPENCODE.*provider-visible/i)
    const reorderedObjectKeys = rows()
    reorderedObjectKeys[0].managed.config = { setting: true, model: 'fixture' }
    reorderedObjectKeys[0].direct.config = { model: 'fixture', setting: true }
    expect(validateProviderParityReceipt({ ...receipt, rows: reorderedObjectKeys }).rows).toHaveLength(7)
  })

  it('rejects failed secret hygiene and unapproved OneCLI access', () => {
    const unsafe = rows()
    unsafe[1].secretHygiene.eventJournal = false
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: unsafe }))
      .toThrow(/eventJournal/i)
    const unapproved = rows()
    unapproved[2].onecli.unapprovedReferenceRejected = false
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: unapproved }))
      .toThrow(/OneCLI/i)
    const noResume = rows()
    noResume[3].recovery.sameNativeSession = false
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: noResume }))
      .toThrow(/native resume/i)
  })

  it('cannot be used as a live provider qualification receipt', () => {
    const receipt = { schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: rows() }
    expect(() => validateProviderQualificationReceipt({
      repoRoot: '/tmp', candidateSha: 'a'.repeat(40), expectedRuntimeImage: 'fixture', receipt,
    })).toThrow()
    expect(() => validateFreshAgentQualificationReceipt({
      repoRoot: '/tmp', candidateSha: 'a'.repeat(40), expectedRuntimeImage: 'fixture', receipt,
    })).toThrow()
  })

  it('binds a stored local receipt to its candidate and rejects exposed files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-parity-receipt-'))
    try {
      const file = path.join(directory, 'receipt.json')
      const receipt = { schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', candidateSha: 'a'.repeat(40), rows: rows() }
      fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 })
      expect(loadProviderParityLocalReceipt(file, 'a'.repeat(40)).rows).toHaveLength(7)
      expect(() => loadProviderParityLocalReceipt(file, 'b'.repeat(40))).toThrow(/candidate SHA/i)
      fs.chmodSync(file, 0o644)
      expect(() => loadProviderParityLocalReceipt(file, 'a'.repeat(40))).toThrow(/private regular file/i)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
