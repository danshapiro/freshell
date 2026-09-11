import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertFreshAgentResults, type FreshAgentQualificationRow } from '../../../../scripts/testing/fresh-agent-test-results.js'
import { FRESH_AGENT_QUALIFICATION_MODES_ENV, parseFreshAgentQualificationModes } from '../../../../scripts/testing/fresh-agent-qualification-selection.js'
import { selectedFreshAgentModeFromArgs } from '../../../../scripts/testing/runtime-fresh-agent-qualification.js'
import { FRESH_AGENT_INGRESS_INVENTORY } from '../../../../scripts/testing/fresh-agent-ingress-inventory.js'
const repoRoot = path.resolve(__dirname, '../../../..')


function row(mode: FreshAgentQualificationRow['mode'] = 'freshclaude'): FreshAgentQualificationRow {
  const definitions = {
    freshclaude: { provider: 'claude', version: '2.1.263', model: 'haiku', effort: 'low', variant: 'claude-agent-sdk', pending: true },
    kilroy: { provider: 'claude', version: '2.1.263', model: 'haiku', effort: 'low', variant: 'kilroy-claude-agent-sdk', pending: true },
    freshcodex: { provider: 'codex', version: '0.147.0', model: 'gpt-5.6-luna', effort: 'low', variant: 'codex-app-server', pending: false },
    freshopencode: { provider: 'opencode', version: '1.18.21', model: 'opencode/big-pickle', effort: 'provider-default', variant: 'opencode-per-soul-http', pending: false },
  } as const
  const definition = definitions[mode]
  return {
    mode,
    provider: definition.provider,
    providerVersion: definition.version,
    model: definition.model,
    effort: definition.effort,
    runtimeVariant: definition.variant,
    actualProviderProcess: true,
    fixtureTransport: false,
    ingresses: FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress),
    soulId: `soul-${mode}`,
    nativeSessionId: `native-${mode}`,
    providerStoreId: `store-${mode}`,
    completedNativeTurns: [
      { turnId: `turn-${mode}-1`, assistantMessageId: `assistant-${mode}-1`, completionKind: 'provider_native_completed' },
      { turnId: `turn-${mode}-2`, assistantMessageId: `assistant-${mode}-2`, completionKind: 'provider_native_completed' },
    ],
    noToolRecall: true,
    crashes: {
      web: ['abrupt_restart'],
      host: ['session_host_exit', 'provider_process_exit'],
    },
    pendingApproval: definition.pending
      ? { supported: true, survivedWebRestart: true, survivedHostRecovery: true, resolvedExactlyOnce: true, decisionIdHash: 'd'.repeat(64) }
      : { supported: false },
    writerProof: {
      activeWriterCount: 1,
      conflictingWriterCount: 0,
      dispatchCountForPrompt: 1,
      completionCountForPrompt: 1,
    },
    isolation: {
      providerVolumeNameHash: 'e'.repeat(64),
      enclosureIdHash: 'f'.repeat(64),
      independentProviderStore: true,
      independentEnclosure: true,
    },
    limits: {
      cpuMax: '50000 100000',
      memoryMax: '268435456',
      swapMax: '0',
      pidsMax: '64',
    },
    oldEnclosure: {
      verifiedEmptyBeforeResume: true,
      writerClaimReleasedBeforeResume: true,
    },
  }
}
function fixture(rows = [row()]) {
  const selectedModes = rows.map(row => row.mode)
  assertFreshAgentResults(repoRoot, selectedModes, rows)
  return { receipt: { selectedModes, rows } }
}


describe('fresh-agent live mode selection', () => {
  it('accepts an explicit ordered subset so each mode can run independently', () => {
    expect(parseFreshAgentQualificationModes('freshcodex')).toEqual(['freshcodex'])
    expect(parseFreshAgentQualificationModes('kilroy,freshopencode')).toEqual(['kilroy', 'freshopencode'])
  })

  it.each(['', 'all', 'freshclaude,freshclaude', 'claude', 'freshcodex, freshopencode', 'unknown']) (
    'rejects empty, broadened, duplicate, aliased, or unknown selection %j before launch',
    (value) => expect(() => parseFreshAgentQualificationModes(value)).toThrow(FRESH_AGENT_QUALIFICATION_MODES_ENV),
  )
})
describe('direct fresh-agent behavior checks', () => {


  it.each(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const)(
    'accepts a truthful independent %s row',
    (mode) => expect(fixture([row(mode)]).receipt.selectedModes).toEqual([mode]),
  )


  it('keeps Kilroy distinct from FreshClaude by provider runtime variant', () => {
    expect(() => fixture([{ ...row('kilroy'), runtimeVariant: 'claude-agent-sdk' }])).toThrow(/kilroy.*runtimeVariant/i)
  })


  it('requires exact native identities, two completed native turns, no-tool recall, and one dispatch/completion', () => {
    expect(() => fixture([{ ...row(), nativeSessionId: '' }])).toThrow(/nativeSessionId/i)
    expect(() => fixture([{ ...row(), completedNativeTurns: [row().completedNativeTurns[0]] }])).toThrow(/completedNativeTurns/i)
    expect(() => fixture([{ ...row(), noToolRecall: false }])).toThrow(/noToolRecall/i)
    expect(() => fixture([{ ...row(), writerProof: { ...row().writerProof, dispatchCountForPrompt: 2 } }])).toThrow(/dispatchCountForPrompt/i)
  })


  it('requires web, host, and provider crashes plus pending-decision survival where supported', () => {
    expect(() => fixture([{ ...row(), crashes: { web: [], host: ['session_host_exit', 'provider_process_exit'] } }])).toThrow(/web.*crash/i)
    expect(() => fixture([{ ...row(), crashes: { web: ['abrupt_restart'], host: ['session_host_exit'] } }])).toThrow(/provider_process_exit/i)
    expect(() => fixture([{ ...row(), pendingApproval: { ...row().pendingApproval, survivedWebRestart: false } }])).toThrow(/pendingApproval/i)
    expect(() => fixture([{ ...row('freshcodex'), pendingApproval: { supported: true } }])).toThrow(/pendingApproval/i)
  })


  it('requires independent stores/enclosures, bounded resources with swap disabled, and old enclosure emptiness', () => {
    expect(() => fixture([{ ...row(), isolation: { ...row().isolation, independentProviderStore: false } }])).toThrow(/independentProviderStore/i)
    expect(() => fixture([{ ...row(), limits: { ...row().limits, swapMax: 'max' } }])).toThrow(/swapMax/i)
    expect(() => fixture([{ ...row(), limits: { ...row().limits, memoryMax: 'max' } }])).toThrow(/memoryMax/i)
    expect(() => fixture([{ ...row(), oldEnclosure: { ...row().oldEnclosure, verifiedEmptyBeforeResume: false } }])).toThrow(/verifiedEmptyBeforeResume/i)
  })


  it.each(['responseText', 'prompt', 'credentialValue', 'rawProviderEvents', 'workspaceData'])(
    'forbids sensitive or echo-like receipt field %s recursively',
    (field) => expect(() => fixture([{ ...row(), proof: { [field]: 'must-not-be-retained' } }])).toThrow(/forbidden|sensitive/i),
  )
  it('rejects fixtures, missing completions, duplicate modes, and empty results', () => {
    expect(() => assertFreshAgentResults(repoRoot, [], [])).toThrow()
    expect(() => fixture([row(), row()])).toThrow(/duplicate/i)
    expect(() => fixture([{ ...row(), completedNativeTurns: [] }])).toThrow(/completedNativeTurns/i)
    expect(() => fixture([{ ...row(), actualProviderProcess: false, fixtureTransport: true } as any])).toThrow(/actual provider|fixture/i)
  })


  it('requires the isolated producer to name exactly one mode', () => {
    expect(selectedFreshAgentModeFromArgs(['--mode', 'freshcodex'])).toBe('freshcodex')
    expect(() => selectedFreshAgentModeFromArgs([])).toThrow(/usage/i)
    expect(() => selectedFreshAgentModeFromArgs(['freshclaude,kilroy'])).toThrow(/exactly one/i)
  })
})
