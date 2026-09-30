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
  provider: 'claude',
  argv: ['provider', '--model', 'fixture-model'],
  env: { FRESHELL: '1' },
  config: { setting: true },
  plugins: ['fixture-plugin'],
  mcp: { exposed: true, tools: ['freshell'], call: { ok: true } },
  operations: ['create', 'send', 'capture', 'resume'],
  nativeSessionId: 'native-session-1',
}

function rows(): ProviderParityRow[] {
  return PROVIDER_PARITY_CASE_IDS.map(caseId => {
    const provider = caseId.replace(/^PC-PARITY-|^FA-PARITY-FRESH/, '').toLowerCase()
    const digest = {
      claude: 'eadc44b07a22ac1dd3cff288bf4226793a69df213ff1164ed0aeb847ac80a3c0',
      codex: '269cb5ee8be6c7d7e6bcbed95231b3a3e5db2edbb1d119ff9ed84f159506b725',
      opencode: '1fda073dcaeb3ac7f140977cf00a53209524d21011aa868317d2ed5801f7eca5',
      amplifier: 'daa3f3c6a1b01fadf1299f1e80bc095aeb4e6235d696f13592b7533ebff7a502',
    }[provider]!
    const key = provider === 'claude' ? 'ANTHROPIC_API_KEY'
      : provider === 'opencode' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'
    const fresh = caseId.startsWith('FA-')
    const transportReference = { sourcePath: '/run/freshell-secrets/onecli/env', profile: `${provider}_onecli_environment` }
    const routeTrace = {
      ...structuredClone(trace), provider,
      argv: fresh ? ['transport.start', `providerSecretReferences=${JSON.stringify([transportReference])}`]
        : [provider, '--model', 'fixture-model'],
      env: fresh ? { providerSecretReferences: [transportReference] } : { FRESHELL: '1' },
      config: fresh ? { providerSecretReferences: [transportReference] } : { providerConfig: { setting: true } },
    }
    return {
      caseId,
      direct: structuredClone(routeTrace),
      managed: structuredClone(routeTrace),
      secretHygiene: { registry: true, supervisor: true, eventJournal: true, docker: true },
      onecli: {
        reference: { provider, profile: `${provider}_onecli_environment`,
          sourcePath: `/tmp/freshell-parity-onecli-test/${provider}.env`, environmentKey: key,
          grantValueSha256: digest },
        child: { provider, argv: fresh ? ['fresh-agent-fixture-worker', '--provider', provider] : routeTrace.argv,
          environmentKey: key, valueSha256: digest, onecliControlPresent: false },
        rejection: { provider, sourcePath: `/tmp/freshell-parity-onecli-test/${provider}.env`,
          requestType: fresh ? 'freshAgent.create' : 'terminal.create',
          responseType: fresh ? 'freshAgent.create.failed' : 'error' },
      },
      recovery: { replacementObserved: true, sameNativeSession: true },
    }
  })
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
    expect(() => validateProviderParityReceipt({ ...receipt, rows: lostFreshInput })).toThrow(/FA-PARITY-FRESHCLAUDE.*transport inputs/i)
    const lostFreshEnvironment = rows()
    delete lostFreshEnvironment[5].managed.env.providerSecretReferences
    expect(() => validateProviderParityReceipt({ ...receipt, rows: lostFreshEnvironment })).toThrow(/FA-PARITY-FRESHCODEX.*environment evidence/i)
    const emptyFreshBoundary = rows()
    emptyFreshBoundary[6].direct.argv = []
    emptyFreshBoundary[6].managed.argv = []
    emptyFreshBoundary[6].direct.env = {}
    emptyFreshBoundary[6].managed.env = {}
    expect(() => validateProviderParityReceipt({ ...receipt, rows: emptyFreshBoundary })).toThrow(/FA-PARITY-FRESHOPENCODE.*provider-visible/i)
    const reorderedObjectKeys = rows()
    reorderedObjectKeys[0].managed.config = { providerConfig: { setting: true, model: 'fixture' } }
    reorderedObjectKeys[0].direct.config = { providerConfig: { model: 'fixture', setting: true } }
    expect(validateProviderParityReceipt({ ...receipt, rows: reorderedObjectKeys }).rows).toHaveLength(7)
  })

  it('rejects failed secret hygiene and unapproved OneCLI access', () => {
    const unsafe = rows()
    unsafe[1].secretHygiene.eventJournal = false
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: unsafe }))
      .toThrow(/eventJournal/i)
    const unapproved = rows()
    unapproved[2].onecli.rejection.responseType = 'freshAgent.created'
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: unapproved }))
      .toThrow(/OneCLI/i)
    const noResume = rows()
    noResume[3].recovery.sameNativeSession = false
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: noResume }))
      .toThrow(/native resume/i)
  })

  it('rejects matching placeholder routes and synthetic OneCLI proof', () => {
    const synthetic = rows()
    for (const row of synthetic) {
      row.direct.argv = ['provider', '--model', 'fixture-model']
      row.managed.argv = [...row.direct.argv]
      row.direct.env = { FRESHELL: '1' }
      row.managed.env = { FRESHELL: '1' }
      row.onecli.reference.grantValueSha256 = 'a'.repeat(64)
      row.onecli.child.valueSha256 = 'a'.repeat(64)
      row.onecli.child.argv = [...row.managed.argv]
    }
    expect(() => validateProviderParityReceipt({ schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: synthetic }))
      .toThrow(/OneCLI|transport/i)
  })

  it('binds provider, grant, child, and failed-create observations to the case', () => {
    const receipt = (changed: ProviderParityRow[]) => ({
      schemaVersion: 1, kind: 'provider-parity-local', status: 'PASS', rows: changed,
    })
    const wrongProvider = rows()
    wrongProvider[0].managed.provider = 'codex'
    expect(() => validateProviderParityReceipt(receipt(wrongProvider))).toThrow(/provider transport identity/i)
    const wrongReference = rows()
    wrongReference[1].onecli.reference.sourcePath = '/tmp/freshell-parity-onecli-test/claude.env'
    expect(() => validateProviderParityReceipt(receipt(wrongReference))).toThrow(/approved reference/i)
    const wrongChild = rows()
    wrongChild[2].onecli.child.valueSha256 = 'b'.repeat(64)
    expect(() => validateProviderParityReceipt(receipt(wrongChild))).toThrow(/redacted child/i)
    const wrongRejection = rows()
    wrongRejection[3].onecli.rejection.sourcePath = '/tmp/freshell-parity-onecli-test/other.env'
    expect(() => validateProviderParityReceipt(receipt(wrongRejection))).toThrow(/failed-create rejection/i)
    const missingTransportReference = rows()
    missingTransportReference[4].direct.argv = ['transport.start', 'providerSecretReferences=[]']
    missingTransportReference[4].managed.argv = ['transport.start', 'providerSecretReferences=[]']
    expect(() => validateProviderParityReceipt(receipt(missingTransportReference))).toThrow(/reference is absent from provider transport inputs/i)
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
