import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertProviderResults, type ProviderQualificationRow } from '../../../../scripts/testing/provider-test-results.js'
const repoRoot = path.resolve(__dirname, '../../../..')


  function providerRow(provider = 'claude'): ProviderQualificationRow {
    const profile = provider === 'codex'
      ? { providerVersion: '0.147.0', model: 'gpt-5.6-luna', reasoningEffort: 'low', nativeProvider: 'openai' }
      : provider === 'opencode'
        ? { providerVersion: '1.18.21', model: 'opencode/big-pickle', reasoningEffort: 'provider-default', nativeProvider: 'opencode' }
        : provider === 'amplifier'
          ? { providerVersion: '0.1.1', model: 'glm-5.3', reasoningEffort: 'provider-default', nativeProvider: 'lunaroute' }
          : { providerVersion: '2.1.263', model: 'haiku', reasoningEffort: 'low', nativeProvider: 'anthropic' }
    const stages = ['initial', 'after_session_host_crash', 'after_provider_process_crash'] as const
    return {
      provider,
      modes: [provider],
      providerVersion: profile.providerVersion,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      nativeSessionId: '11111111-1111-4111-8111-111111111111',
      nonceSha256: 'd'.repeat(64),
      nativeTurnProofs: stages.map((stage, index) => ({
        schemaVersion: 2 as const,
        stage,
        nativeSessionId: '11111111-1111-4111-8111-111111111111',
        nativeEvidence: provider === 'amplifier'
          ? {
              kind: 'append_only_record' as const,
              recordIndex: index * 2 + 1,
              byteStart: 100 + index * 100,
              byteEnd: 180 + index * 100,
              recordSha256: String(index + 4).repeat(64),
              prefixSha256Before: String(index + 7).repeat(64),
              completionEventOrdinal: index + 1,
              completionEventSha256: String(index + 1).repeat(64),
            }
          : {
              kind: 'identified_message' as const,
              turnId: `turn-${index + 1}`,
              messageId: `message-${index + 1}`,
              parentMessageId: index === 0 ? 'user-1' : `user-${index + 1}`,
            },
        completedAt: `2026-09-01T00:00:0${index + 1}.000Z`,
        responseSha256: String(index + 1).repeat(64),
        responseContainsNonce: true as const,
        toolCallCount: 0,
        toolCallTypes: [],
        resolvedProvider: profile.nativeProvider,
        resolvedModel: profile.model === 'haiku' ? 'claude-haiku-4-5-20251001' : profile.model.replace(/^opencode\//, ''),
        resolvedReasoningEffort: profile.reasoningEffort,
        providerProvenance: `${provider}-native.provider`,
        modelProvenance: `${provider}-native.model`,
        reasoningEffortProvenance: `${provider}-native.effort`,
      })),
      actualProviderBinary: true,
      completedTurn: true,
      nativeStateCaptured: true,
      runtimeOwned: true,
      limitsVerified: true,
      swapMaxVerified: true,
      limitEvidence: {
        cpuMax: '50000 100000',
        memoryMax: '134217728',
        swapMax: '0',
        pidsMax: '64',
      },
      automaticResume: true,
      profileVerified: true,
      releaseBinary: true,
      nativeRecovery: true,
      exactNativeRecovery: true,
      sameNativeSession: true,
      followUpCompleted: true,
      onlyOneWriter: true,
      writerClaim: {
        provider,
        providerStoreId: 'store-qualified',
        nativeSessionId: '11111111-1111-4111-8111-111111111111',
        soulId: 'soul-qualified',
        incarnationId: 'inc-qualified',
        activeClaimCount: 1,
        globalConflictingClaimCount: 0,
      },
      oldEnclosureVerifiedEmpty: true,
      verifiedEmptyOrdering: {
        stopOutcome: 'verified_empty',
        activeClaimCountAfterStop: 0,
        globalConflictingClaimCountAfterStop: 0,
        oldContainerRunningAfterStop: false,
      },
      lostNoticeCount: 0,
      crashKinds: ['session_host', 'provider_process'],
    }
  }
function evidenceFixture(rows = [providerRow()]) {
  assertProviderResults(repoRoot, rows)
  return { receipt: { providers: rows } }
}
describe('direct provider behavior checks', () => {


  it.each([
    ['actualProviderBinary', false],
    ['completedTurn', false],
    ['nativeRecovery', false],
    ['exactNativeRecovery', false],
    ['sameNativeSession', false],
    ['followUpCompleted', false],
    ['onlyOneWriter', false],
    ['limitsVerified', false],
    ['swapMaxVerified', false],
    ['oldEnclosureVerifiedEmpty', false],
    ['lostNoticeCount', 1],
  ] as const)('rejects provider evidence when %s is not qualifying', (field, value) => {
    const row = { ...providerRow(), [field]: value }
    expect(() => evidenceFixture([row])).toThrow(new RegExp(field, 'i'))
  })


  it('requires measured swap.max, a globally unique writer tuple, and post-stop ordering', () => {
    expect(() => evidenceFixture([{
      ...providerRow(),
      limitEvidence: { ...providerRow().limitEvidence, swapMax: 'max' },
    }])).toThrow(/swapMax/i)
    expect(() => evidenceFixture([{
      ...providerRow(),
      writerClaim: { ...providerRow().writerClaim, globalConflictingClaimCount: 1 },
    }])).toThrow(/writerClaim/i)
    expect(() => evidenceFixture([{
      ...providerRow(),
      verifiedEmptyOrdering: {
        ...providerRow().verifiedEmptyOrdering,
        activeClaimCountAfterStop: 1,
      },
    }])).toThrow(/verifiedEmptyOrdering/i)
  })


  it.each(['providerVersion', 'model', 'reasoningEffort', 'nativeSessionId'] as const)(
    'requires the exact provider %s identity',
    (field) => {
      expect(() => evidenceFixture([{ ...providerRow(), [field]: '' }])).toThrow(new RegExp(field, 'i'))
    },
  )


  it('requires three cryptographic native completed-turn proofs for the exact session', () => {
    const row = providerRow()
    expect(() => evidenceFixture([{ ...row, nativeTurnProofs: undefined } as any])).toThrow(/nativeTurnProofs/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.slice(0, 2),
    }])).toThrow(/three|required stages/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof, index) => index === 2
        ? { ...proof, nativeSessionId: 'different-session' }
        : proof),
    }])).toThrow(/nativeSessionId|exact session/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof, index) => index === 2
        ? { ...proof, nativeEvidence: { ...proof.nativeEvidence, messageId: (row.nativeTurnProofs[1].nativeEvidence as any).messageId } }
        : proof),
    }])).toThrow(/distinct.*message/i)
  })



  it('accepts Amplifier continuity from native append positions without fabricated message ids', () => {
    const row = providerRow('amplifier') as any
    row.nativeTurnProofs = row.nativeTurnProofs.map((proof: any, index: number) => ({
      ...proof,
      schemaVersion: 2,
      nativeEvidence: {
        kind: 'append_only_record',
        recordIndex: 2 * index + 1,
        byteStart: 100 + index * 100,
        byteEnd: 180 + index * 100,
        recordSha256: String(index + 4).repeat(64),
        prefixSha256Before: String(index + 7).repeat(64),
        completionEventOrdinal: index + 1,
        completionEventSha256: String(index + 1).repeat(64),
      },
    }))
    for (const proof of row.nativeTurnProofs) {
      delete proof.turnId
      delete proof.messageId
      delete proof.parentMessageId
    }
    expect(() => evidenceFixture([row])).not.toThrow()
  })


  it('still requires provider-native IDs where the provider actually exposes them', () => {
    const row = providerRow('codex') as any
    row.nativeTurnProofs[1] = {
      ...row.nativeTurnProofs[1],
      nativeEvidence: { ...row.nativeTurnProofs[1].nativeEvidence, messageId: undefined },
    }
    expect(() => evidenceFixture([row])).toThrow(/message.*id|identified/i)
  })


  it('rejects fabricated Amplifier IDs in place of append-position evidence', () => {
    const row = providerRow('amplifier') as any
    row.nativeTurnProofs = row.nativeTurnProofs.map((proof: any, index: number) => ({
      ...proof,
      nativeEvidence: {
        kind: 'identified_message',
        turnId: `invented-turn-${index}`,
        messageId: `invented-message-${index}`,
        parentMessageId: null,
      },
    }))
    expect(() => evidenceFixture([row])).toThrow(/append|native evidence|Amplifier/i)
  })


  it('requires zero native tool calls for recall and native model/effort provenance', () => {
    const row = providerRow('codex')
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof, index) => index === 1
        ? { ...proof, toolCallCount: 1, toolCallTypes: ['function_call:read_file'] }
        : proof),
    }])).toThrow(/tool/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof) => ({
        ...proof,
        reasoningEffortProvenance: 'process-args',
      })),
    }])).toThrow(/provenance|process-args/i)
  })


  it('rejects raw prompts, raw responses, nonce values, and synthetic secrets before writing evidence', () => {
    const row = providerRow()
    expect(() => evidenceFixture([{ ...row, responseText: 'harmless raw response' }])).toThrow(/redact|responseText/i)
    expect(() => evidenceFixture([{ ...row, nonce: '00112233445566778899aabbccddeeff' }])).toThrow(/redact|nonce/i)
    expect(() => evidenceFixture([{ ...row, diagnostic: 'Bearer synthetic-secret-value' }])).toThrow(/secret|redact/i)
    expect(() => evidenceFixture([{ ...row, diagnostic: 'sk-synthetic-secret-value' }])).toThrow(/secret|redact/i)
  })
  it.each(['claude','codex','opencode','amplifier'])('checks the real %s profile without a certificate or evidence directory', provider => {
    expect(() => assertProviderResults(repoRoot, [providerRow(provider)])).not.toThrow()
  })
  it('still rejects a different installed provider version', () => {
    expect(() => assertProviderResults(repoRoot, [{ ...providerRow(), providerVersion: 'different-version' }])).toThrow(/version/i)
  })


  it('pins managed Amplifier to the actual OneCLI/LunaRoute profile without changing legacy launch', () => {
    const settings = fs.readFileSync(
      path.join(repoRoot, 'docker/runtime/amplifier-onecli-lunaroute-glm53.yaml'),
      'utf8',
    )
    expect(settings).toContain('id: lunaroute')
    expect(settings).toContain('module: provider-vllm')
    expect(settings).toContain('default_model: glm-5.3')
    expect(settings).not.toMatch(/anthropic|haiku|fable|gpt-5\.6-sol|max/i)
    execFileSync('sh', ['-n', path.join(repoRoot, 'docker/runtime/amplifier-onecli')])
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'extensions/amplifier/freshell.json'), 'utf8'),
    )
    expect(manifest.cli.command).toBe('amplifier')
  })
})
